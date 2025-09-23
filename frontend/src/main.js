import './styles.css';
import 'leaflet/dist/leaflet.css';
import * as d3 from 'd3';
import Fuse from 'fuse.js';
import L from 'leaflet';
import iconRetina from 'leaflet/dist/images/marker-icon-2x.png';
import iconDefault from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

L.Icon.Default.mergeOptions({
  iconRetinaUrl: iconRetina,
  iconUrl: iconDefault,
  shadowUrl: iconShadow
});

const DEFAULTS = {
  cityId: '5000',
  cityName: 'תל אביב - יפו',
  streetKey: 'הרצל'
};

const state = {
  ready: false,
  cities: [],
  cityMap: new Map(),
  cityNameLookup: new Map(),
  similarityTop: new Map(),
  similarityLookup: new Map(),
  streetIndex: new Map(),
  rarityWeights: {},
  cityHonors: {
    graph: null,
    nodesById: new Map(),
    pathEdgeKeys: new Set(),
    cycleEdgeKeys: new Set(),
    pathNodeIds: new Set(),
    cycleNodeIds: new Set()
  },
  fuse: null,
  cityFuse: null,
  cityCoords: null,
  graphLayouts: new Map(),
  graphSettings: {
    layout: 'force',
    metric: 'weightedJaccard'
  },
  defaults: {
    cityId: '',
    streetKey: ''
  },
  streetKeyCache: new Map(),
  rendered: {
    networkPreview: false,
    heatmap: false,
    graphFull: false,
    cityHonors: false
  }
};

const elements = {
  views: Array.from(document.querySelectorAll('[data-view]')),
  navLinks: Array.from(document.querySelectorAll('.nav-link')),
  toast: document.getElementById('global-toast'),
  home: {
    network: document.getElementById('network-preview'),
    heatmap: document.getElementById('similarity-heatmap'),
    topList: document.getElementById('top-cities-list')
  },
  graph: {
    canvas: document.getElementById('graph-view-canvas'),
    layoutSelect: document.getElementById('graph-layout-select'),
    metricSelect: document.getElementById('graph-metric-select')
  },
  dedications: {
    summary: document.getElementById('city-chain-summary'),
    graph: document.getElementById('city-chain-graph'),
    path: document.getElementById('city-chain-path'),
    cycle: document.getElementById('city-chain-cycle')
  },
  city: {
    primarySelect: document.getElementById('city-select-primary'),
    secondarySelect: document.getElementById('city-select-secondary'),
    primarySuggestions: document.getElementById('city-primary-suggestions'),
    secondarySuggestions: document.getElementById('city-secondary-suggestions'),
    summary: document.getElementById('city-summary'),
    chart: document.getElementById('city-similarity-chart'),
    similarList: document.getElementById('city-similar-list'),
    sharedList: document.getElementById('shared-streets'),
    overlap: document.getElementById('city-overlap-list')
  },
  street: {
    searchInput: document.getElementById('street-search'),
    searchButton: document.getElementById('street-search-btn'),
    results: document.getElementById('street-results'),
    details: document.getElementById('street-details')
  }
};

let streetMapInstance = null;
let resizeTimer = null;

function makeEdgeKey(source, target) {
  return `${source}__${target}`;
}

function toggleLoading(show, message = 'טוען נתונים...') {
  let overlay = document.getElementById('app-loading-overlay');
  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'app-loading-overlay';
      overlay.className = 'loading-overlay';
      overlay.innerHTML = `
        <div class="loading-spinner"></div>
        <p>${message}</p>
      `;
      document.body.appendChild(overlay);
    }
    overlay.querySelector('p').textContent = message;
    overlay.hidden = false;
    overlay.style.display = 'flex';
    console.debug('[ui] loading overlay shown', { message });
  } else if (overlay) {
    overlay.hidden = true;
    overlay.style.display = 'none';
    console.debug('[ui] loading overlay hidden');
  }
}

function showToast(message, tone = 'error') {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.style.borderColor = tone === 'error' ? 'rgba(239,68,68,0.5)' : 'rgba(34,211,238,0.6)';
  elements.toast.hidden = false;
  elements.toast.style.opacity = '1';
  setTimeout(() => {
    if (!elements.toast) return;
    elements.toast.style.opacity = '0';
    setTimeout(() => {
      if (elements.toast) elements.toast.hidden = true;
    }, 300);
  }, 4000);
}

function hideCitySuggestions(list) {
  if (!list) return;
  list.innerHTML = '';
  list.hidden = true;
}

function findCityByName(name) {
  if (!name) return null;
  const normalized = name.trim();
  if (!normalized) return null;
  return state.cityNameLookup.get(normalized) || null;
}

function resolveDefaultCityId() {
  if (state.defaults.cityId && state.cityMap.has(state.defaults.cityId)) {
    return state.defaults.cityId;
  }
  if (DEFAULTS.cityId && state.cityMap.has(DEFAULTS.cityId)) {
    state.defaults.cityId = DEFAULTS.cityId;
    return state.defaults.cityId;
  }
  if (DEFAULTS.cityName) {
    const direct = findCityByName(DEFAULTS.cityName);
    if (direct) {
      state.defaults.cityId = direct.id;
      return state.defaults.cityId;
    }
    if (state.cityFuse) {
      const results = state.cityFuse.search(DEFAULTS.cityName);
      if (Array.isArray(results) && results.length) {
        const match = results[0] && results[0].item;
        if (match && match.id && state.cityMap.has(match.id)) {
          state.defaults.cityId = match.id;
          return state.defaults.cityId;
        }
      }
    }
  }
  state.defaults.cityId = '';
  return '';
}

function resolveDefaultStreetKey() {
  if (state.defaults.streetKey && state.streetIndex.has(state.defaults.streetKey)) {
    return state.defaults.streetKey;
  }
  if (DEFAULTS.streetKey && state.streetIndex.has(DEFAULTS.streetKey)) {
    state.defaults.streetKey = DEFAULTS.streetKey;
    return state.defaults.streetKey;
  }
  if (DEFAULTS.streetKey) {
    for (const [key, entry] of state.streetIndex.entries()) {
      if (entry && entry.display === DEFAULTS.streetKey) {
        state.defaults.streetKey = key;
        return state.defaults.streetKey;
      }
    }
    if (state.fuse) {
      const results = state.fuse.search(DEFAULTS.streetKey);
      if (Array.isArray(results) && results.length) {
        const match = results[0] && results[0].item;
        if (match && match.key && state.streetIndex.has(match.key)) {
          state.defaults.streetKey = match.key;
          return state.defaults.streetKey;
        }
      }
    }
  }
  state.defaults.streetKey = '';
  return '';
}

function resolveStreetKey(streetKey) {
  if (streetKey === null || streetKey === undefined) return '';
  const raw = String(streetKey);
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const cached = state.streetKeyCache.get(trimmed);
  if (cached && state.streetIndex.has(cached)) {
    return cached;
  }
  if (state.streetIndex.has(trimmed)) {
    state.streetKeyCache.set(trimmed, trimmed);
    return trimmed;
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (compact && state.streetIndex.has(compact)) {
    state.streetKeyCache.set(trimmed, compact);
    state.streetKeyCache.set(compact, compact);
    return compact;
  }
  let resolved = '';
  for (const [key, entry] of state.streetIndex.entries()) {
    if (!entry) continue;
    const display = (entry.display || '').trim();
    if (display && (display === trimmed || display === raw)) {
      resolved = key;
      break;
    }
    if (display && compact && display.replace(/\s+/g, '') === compact) {
      resolved = key;
      break;
    }
    if (Array.isArray(entry.cities)) {
      const found = entry.cities.find(cityEntry => {
        if (!cityEntry) return false;
        const variants = [
          cityEntry.streetDisplay || '',
          cityEntry.normDisplay || ''
        ];
        return variants.some(name => {
          if (!name) return false;
          const nameTrimmed = String(name).trim();
          if (!nameTrimmed) return false;
          if (nameTrimmed === trimmed || nameTrimmed === raw) return true;
          if (compact && nameTrimmed.replace(/\s+/g, '') === compact) return true;
          return false;
        });
      });
      if (found) {
        resolved = key;
        break;
      }
    }
  }
  if (resolved) {
    state.streetKeyCache.set(trimmed, resolved);
    if (compact) {
      state.streetKeyCache.set(compact, resolved);
    }
    return resolved;
  }
  return '';
}

function getSimilarityEntry(sourceId, targetId) {
  if (!sourceId || !targetId) return null;
  const sourceMap = state.similarityLookup.get(sourceId);
  if (sourceMap && sourceMap.has(targetId)) {
    return sourceMap.get(targetId) || null;
  }
  const reverseMap = state.similarityLookup.get(targetId);
  if (reverseMap && reverseMap.has(sourceId)) {
    const reverse = reverseMap.get(sourceId);
    if (!reverse) return null;
    return {
      ...reverse,
      city: targetId,
      cityName: state.cityMap.get(targetId)?.name || reverse.cityName || targetId
    };
  }
  return null;
}

function getSimilarityMetric(sourceId, targetId, metric = 'weightedJaccard') {
  const entry = getSimilarityEntry(sourceId, targetId);
  if (!entry) return 0;
  const value = entry?.[metric];
  if (typeof value === 'number') return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}


function applyDefaultSelections() {
  const defaultCityId = resolveDefaultCityId();
  if (defaultCityId) {
    setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, defaultCityId);
  }
  const defaultStreetKey = resolveDefaultStreetKey();
  if (defaultStreetKey && elements.street.searchInput) {
    const entry = state.streetIndex.get(defaultStreetKey);
    if (entry) {
      elements.street.searchInput.value = entry.display;
    }
  }
}

function setCityInputValue(input, suggestionList, cityId) {
  if (!input) return;
  if (!cityId) {
    input.value = '';
    delete input.dataset.selectedId;
    hideCitySuggestions(suggestionList);
    return;
  }
  const city = state.cityMap.get(cityId);
  if (!city) return;
  input.value = city.name;
  input.dataset.selectedId = city.id;
  hideCitySuggestions(suggestionList);
}

function getSelectedCityId(input) {
  if (!input) return '';
  return input.dataset?.selectedId || '';
}

function wireCityAutocomplete(input, suggestionList, handlers = {}) {
  if (!input || !suggestionList) return;

  let currentSuggestions = [];
  let highlightedIndex = -1;

  const updateOptionHighlight = () => {
    const options = suggestionList.querySelectorAll('.autocomplete-option');
    options.forEach((option, index) => {
      option.classList.toggle('is-highlighted', index === highlightedIndex);
    });
  };

  const selectCity = (city, { emit = true } = {}) => {
    if (!city) {
      input.value = '';
      delete input.dataset.selectedId;
      hideCitySuggestions(suggestionList);
      highlightedIndex = -1;
      currentSuggestions = [];
      if (emit && typeof handlers.onClear === 'function') {
        handlers.onClear();
      }
      return;
    }
    input.value = city.name;
    input.dataset.selectedId = city.id;
    hideCitySuggestions(suggestionList);
    highlightedIndex = -1;
    currentSuggestions = [];
    if (emit && typeof handlers.onSelect === 'function') {
      handlers.onSelect(city);
    }
  };

  const renderSuggestions = query => {
    const trimmed = query.trim();
    if (!trimmed) {
      hideCitySuggestions(suggestionList);
      highlightedIndex = -1;
      currentSuggestions = [];
      return;
    }

    const baseResults = state.cityFuse
      ? state.cityFuse.search(trimmed).map(result => result.item)
      : state.cities.filter(city => city.name.includes(trimmed));

    currentSuggestions = baseResults.slice(0, 8);
    highlightedIndex = -1;

    if (!currentSuggestions.length) {
      hideCitySuggestions(suggestionList);
      return;
    }

    const fragment = document.createDocumentFragment();
    currentSuggestions.forEach((city, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'autocomplete-option';
      button.textContent = city.name;
      button.dataset.cityId = city.id;
      button.addEventListener('click', () => selectCity(city));
      fragment.appendChild(button);
    });

    suggestionList.innerHTML = '';
    suggestionList.appendChild(fragment);
    suggestionList.hidden = false;
  };

  input.addEventListener('input', () => {
    const value = input.value || '';
    if (!value.trim()) {
      selectCity(null);
      return;
    }
    renderSuggestions(value);
  });

  input.addEventListener('focus', () => {
    const value = input.value || '';
    if (value.trim()) {
      renderSuggestions(value);
    }
  });

  input.addEventListener('keydown', event => {
    if (!currentSuggestions.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightedIndex = (highlightedIndex + 1) % currentSuggestions.length;
      updateOptionHighlight();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightedIndex = highlightedIndex <= 0
        ? currentSuggestions.length - 1
        : highlightedIndex - 1;
      updateOptionHighlight();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = highlightedIndex >= 0
        ? currentSuggestions[highlightedIndex]
        : currentSuggestions[0];
      if (choice) selectCity(choice);
    } else if (event.key === 'Escape') {
      hideCitySuggestions(suggestionList);
      highlightedIndex = -1;
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (document.activeElement && suggestionList.contains(document.activeElement)) {
        return;
      }
      hideCitySuggestions(suggestionList);
      highlightedIndex = -1;
      if (!input.value.trim()) {
        selectCity(null, { emit: true });
        return;
      }
      if (!input.dataset.selectedId) {
        const exact = findCityByName(input.value);
        if (exact) {
          selectCity(exact, { emit: true });
        }
      }
    }, 120);
  });

  document.addEventListener('click', event => {
    if (event.target === input) return;
    if (suggestionList.contains(event.target)) return;
    hideCitySuggestions(suggestionList);
    highlightedIndex = -1;
  });

}

function resetCityInputs() {
  [
    [elements.city.primarySelect, elements.city.primarySuggestions],
    [elements.city.secondarySelect, elements.city.secondarySuggestions]
  ].forEach(([input, suggestions]) => {
    if (!input) return;
    input.value = '';
    delete input.dataset.selectedId;
    hideCitySuggestions(suggestions);
  });
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { view: 'home', params: [] };
  const parts = raw.split('/').filter(Boolean);
  const [view, ...params] = parts;
  return { view: view || 'home', params };
}

function setActiveNav(view) {
  elements.navLinks.forEach(link => {
    const target = link.dataset.view;
    link.classList.toggle('active', target === view);
  });
}

function showView(view) {
  elements.views.forEach(section => {
    section.hidden = section.dataset.view !== view;
  });
}

function onRouteChange() {
  const { view, params } = parseHash();
  showView(view);
  setActiveNav(view);
  if (!state.ready) return;
  if (view === 'home') {
    renderHome();
  } else if (view === 'city') {
    const [primary, secondary] = params;
    const fallbackId = resolveDefaultCityId();
    const primaryId = primary && state.cityMap.has(primary) ? primary : fallbackId;
    const secondaryId = secondary && state.cityMap.has(secondary) ? secondary : '';
    if (primaryId) {
      setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, primaryId);
      if (secondaryId) {
        setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, secondaryId);
      } else {
        setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
      }
      renderCity(primaryId, secondaryId);
      const expectedHash = secondaryId ? '#/city/' + primaryId + '/' + secondaryId : '#/city/' + primaryId;
      if (window.location.hash !== expectedHash) {
        window.location.hash = expectedHash;
      }
    } else {
      setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, '');
      setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
      renderCity('', '');
    }
  } else if (view === 'street') {
    const [streetKey] = params;
    const fallbackKey = resolveDefaultStreetKey();
    const targetKey = streetKey && state.streetIndex.has(streetKey) ? streetKey : fallbackKey;
    if (targetKey) {
      renderStreetDetails(targetKey, false);
      const entry = state.streetIndex.get(targetKey);
      if (entry && elements.street.searchInput) {
        elements.street.searchInput.value = entry.display;
      }
      const expectedHash = '#/street/' + targetKey;
      if (window.location.hash !== expectedHash) {
        window.location.hash = expectedHash;
      }
    }
  } else if (view === 'dedications') {
    renderCityDedicationView(true);
  } else if (view === 'graph') {
    state.rendered.graphFull = false;
    renderGraphView(true);
  }
}

async function loadData() {
  console.info('[data] loadData start');
  console.time('[data] total');
  toggleLoading(true, 'טוען נתוני בסיס...');
  try {
    const base = `${import.meta.env.BASE_URL}data/processed`;
    const fetchJson = async (name, { optional = false } = {}) => {
      console.info(`[data] fetching ${name}`);
      const response = await fetch(`${base}/${name}`, { cache: 'no-store' });
      if (!response.ok) {
        if (optional && response.status === 404) {
          console.warn('[data] optional dataset missing', name);
          return null;
        }
        console.error('[data] fetch failed', name, response.status, response.statusText);
        throw new Error(`לא ניתן לטעון את הקובץ ${name} (סטטוס ${response.status})`);
      }
      const payload = await response.json();
      const meta = Array.isArray(payload)
        ? { items: payload.length }
        : payload && typeof payload === 'object'
          ? { keys: Object.keys(payload).length }
          : {};
      console.info(`[data] loaded ${name}`, meta);
      return payload;
    };

    const [cities, similarityTop, streetIndex, rarity, honorGraph] = await Promise.all([
      fetchJson('cities.json'),
      fetchJson('similarity_top.json'),
      fetchJson('street_index.json'),
      fetchJson('rarity_weights.json'),
      fetchJson('city_name_graph.json', { optional: true })
    ]);

    console.info('[data] datasets loaded', {
      cities: Array.isArray(cities) ? cities.length : 'n/a',
      similarityTop: similarityTop && typeof similarityTop === 'object' ? Object.keys(similarityTop).length : 'n/a',
      streets: streetIndex && typeof streetIndex === 'object' ? Object.keys(streetIndex).length : 'n/a'
    });

    toggleLoading(true, 'מעבד ויזואליזציות...');

    state.cities = Array.isArray(cities) ? cities : [];
    state.cityMap = new Map(state.cities.map(city => [city.id, city]));
    state.cityNameLookup = new Map(state.cities.map(city => [city.name, city]));
    state.graphLayouts.clear();

    state.similarityTop = new Map(Object.entries(similarityTop || {}));
    const similarityLookup = new Map();
    state.similarityTop.forEach((list, cityId) => {
      const directMap = similarityLookup.get(cityId) || new Map();
      (list || []).forEach(item => {
        if (!item || !item.city) return;
        directMap.set(item.city, item);

        const reverseKey = item.city;
        const reverseMap = similarityLookup.get(reverseKey) || new Map();
        if (!reverseMap.has(cityId)) {
          reverseMap.set(cityId, {
            ...item,
            city: cityId,
            cityName: state.cityMap.get(cityId)?.name || item.cityName || cityId
          });
        }
        similarityLookup.set(reverseKey, reverseMap);
      });
      similarityLookup.set(cityId, directMap);
    });
    state.similarityLookup = similarityLookup;

    state.streetIndex = new Map(Object.entries(streetIndex || {}));
    state.streetKeyCache.clear();
    state.streetIndex.forEach((entry, key) => {
      if (!entry) return;
      state.streetKeyCache.set(key, key);
      const displayName = typeof entry.display === 'string' ? entry.display.trim() : '';
      if (displayName) {
        state.streetKeyCache.set(displayName, key);
        state.streetKeyCache.set(displayName.replace(/\s+/g, ''), key);
      }
      if (Array.isArray(entry.cities)) {
        entry.cities.forEach(cityEntry => {
          if (!cityEntry) return;
          const variants = [cityEntry.streetDisplay, cityEntry.normDisplay];
          variants.forEach(name => {
            if (!name) return;
            const trimmed = String(name).trim();
            if (!trimmed) return;
            state.streetKeyCache.set(trimmed, key);
            state.streetKeyCache.set(trimmed.replace(/\s+/g, ''), key);
          });
        });
      }
    });
    state.rarityWeights = rarity || {};
    state.cityHonors = prepareCityHonorGraph(honorGraph);
    state.cityFuse = state.cities.length
      ? new Fuse(state.cities, {
          keys: ['name'],
          threshold: 0.3,
          minMatchCharLength: 1,
          ignoreLocation: true
        })
      : null;
    state.rendered.networkPreview = false;
    state.rendered.heatmap = false;
    state.rendered.graphFull = false;
    state.rendered.cityHonors = false;

    const streetItems = Array.from(state.streetIndex.entries()).map(([key, value]) => ({
      key,
      name: value.display,
      normalized: key
    }));
    state.fuse = streetItems.length
      ? new Fuse(streetItems, {
          keys: ['name', 'normalized'],
          threshold: 0.35,
          includeScore: true,
          minMatchCharLength: 2
        })
      : null;

    console.info('[data] fuse index ready', { entries: streetItems.length });

    state.defaults.cityId = resolveDefaultCityId();
    state.defaults.streetKey = resolveDefaultStreetKey();

    try {
      console.info('[data] attempting to fetch city_coords.json');
      const coordsResponse = await fetch(`${base}/city_coords.json`, { cache: 'no-store' });
      if (coordsResponse.ok) {
        const coords = await coordsResponse.json();
        state.cityCoords = new Map(Object.entries(coords || {}));
        console.info('[data] city coordinates loaded', { cities: state.cityCoords.size });
      } else if (coordsResponse.status !== 404) {
        console.warn('[data] city_coords.json request returned', coordsResponse.status, coordsResponse.statusText);
      } else {
        console.info('[data] city_coords.json not found (map layer disabled)');
      }
    } catch (coordsError) {
      console.warn('[data] city_coords.json fetch error', coordsError);
    }

    resetCityInputs();
    applyDefaultSelections();
    renderHome();
    state.ready = true;
    onRouteChange();
    console.info('[data] loadData succeeded');
  } catch (error) {
    console.error('[data] loadData error', error);
    showToast('טעינת הנתונים נכשלה. ודאו שהקבצים זמינים ב-public/data/processed.', 'error');
  } finally {
    toggleLoading(false);
    console.timeEnd('[data] total');
  }
}

function prepareCityHonorGraph(raw) {
  const base = {
    graph: null,
    nodesById: new Map(),
    pathEdgeKeys: new Set(),
    cycleEdgeKeys: new Set(),
    pathNodeIds: new Set(),
    cycleNodeIds: new Set()
  };

  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const stats = raw.stats || {};
  const pathEdgeKeys = new Set();
  const cycleEdgeKeys = new Set();
  const pathNodeIds = new Set();
  const cycleNodeIds = new Set();

  const pathEntry = stats.longestPath;
  if (pathEntry && Array.isArray(pathEntry.cities)) {
    pathEntry.cities.forEach(cityId => pathNodeIds.add(String(cityId)));
  }
  if (pathEntry && Array.isArray(pathEntry.edges)) {
    pathEntry.edges.forEach(edge => {
      if (!edge || edge.source === undefined || edge.target === undefined) return;
      pathEdgeKeys.add(makeEdgeKey(String(edge.source), String(edge.target)));
    });
  }

  const cycleEntry = stats.longestCycle;
  if (cycleEntry && Array.isArray(cycleEntry.cities)) {
    cycleEntry.cities.forEach(cityId => cycleNodeIds.add(String(cityId)));
  }
  if (cycleEntry && Array.isArray(cycleEntry.edges)) {
    cycleEntry.edges.forEach(edge => {
      if (!edge || edge.source === undefined || edge.target === undefined) return;
      cycleEdgeKeys.add(makeEdgeKey(String(edge.source), String(edge.target)));
    });
  }

  const graph = {
    nodes: Array.isArray(raw.nodes)
      ? raw.nodes.map(node => ({
          ...node,
          id: String(node.id)
        }))
      : [],
    links: Array.isArray(raw.links)
      ? raw.links.map(link => ({
          ...link,
          source: String(link.source),
          target: String(link.target)
        }))
      : [],
    stats
  };

  if (!graph.links.length) {
    const emptyGraph = {
      nodes: [],
      links: [],
      stats
    };
    return {
      graph: emptyGraph,
      nodesById: new Map(),
      pathEdgeKeys,
      cycleEdgeKeys,
      pathNodeIds,
      cycleNodeIds
    };
  }

  const degreeMap = new Map();
  const ensureDegree = id => {
    const key = String(id);
    if (!degreeMap.has(key)) {
      degreeMap.set(key, { in: 0, out: 0 });
    }
    return degreeMap.get(key);
  };

  graph.links.forEach(link => {
    if (!link || link.source === undefined || link.target === undefined) return;
    ensureDegree(link.source).out += 1;
    ensureDegree(link.target).in += 1;
  });

  const connectedNodeIds = new Set();
  degreeMap.forEach((degree, id) => {
    if ((degree.in || 0) + (degree.out || 0) > 0) {
      connectedNodeIds.add(id);
    }
  });

  const filteredNodes = graph.nodes.filter(node => connectedNodeIds.has(node.id));
  const filteredLinks = graph.links.filter(
    link => connectedNodeIds.has(link.source) && connectedNodeIds.has(link.target)
  );

  const nodeDegree = new Map();
  const ensureNodeDegree = id => {
    const key = String(id);
    if (!nodeDegree.has(key)) {
      nodeDegree.set(key, { in: 0, out: 0 });
    }
    return nodeDegree.get(key);
  };

  filteredLinks.forEach(link => {
    ensureNodeDegree(link.source).out += 1;
    ensureNodeDegree(link.target).in += 1;
  });

  const filteredNodesById = new Map(filteredNodes.map(node => [node.id, { ...node }]));

  const donorsByTarget = new Map();
  filteredLinks.forEach(link => {
    const sourceId = String(link.source);
    const targetId = String(link.target);
    const degree = nodeDegree.get(sourceId) || { in: 0, out: 0 };
    if (degree.out !== 1 || degree.in !== 0) return;
    if (pathNodeIds.has(sourceId) || cycleNodeIds.has(sourceId)) return;
    const sourceNode = filteredNodesById.get(sourceId);
    if (!sourceNode) return;
    if (!donorsByTarget.has(targetId)) {
      donorsByTarget.set(targetId, []);
    }
    donorsByTarget.get(targetId).push({ node: sourceNode, link });
  });

  const nodesToRemove = new Set();
  const aggregatedNodes = [];
  const aggregatedLinks = [];
  const AGGREGATION_THRESHOLD = 4;

  // Collapse sets of leaf nodes that only honor a single city into one aggregate node
  // so the visualization remains legible even when many small cities point to the same hub.

  donorsByTarget.forEach((entries, targetId) => {
    const validEntries = entries.filter(entry => entry && entry.node && entry.link);
    if (validEntries.length < AGGREGATION_THRESHOLD) return;

    const aggregateId = `group:${targetId}`;
    const aggregateSize = validEntries.length;
    const aggregateCityIds = validEntries.map(entry => entry.node.id);
    const aggregateCityNames = validEntries
      .map(entry => entry.node.name || entry.node.displayName || entry.node.id)
      .filter(Boolean);

    let streetTotal = 0;
    const uniqueStreets = new Map();

    validEntries.forEach(({ link }) => {
      const streetCount = Number(link?.streetCount || 0);
      if (streetCount > 0) {
        streetTotal += streetCount;
      } else if (Array.isArray(link?.streets)) {
        streetTotal += link.streets.length;
      } else if (Array.isArray(link?.streetNames)) {
        streetTotal += link.streetNames.length;
      } else {
        streetTotal += 1;
      }

      if (Array.isArray(link?.streets)) {
        link.streets.forEach(street => {
          const label = street?.display || street?.name || '';
          if (!label) return;
          if (!uniqueStreets.has(label)) {
            uniqueStreets.set(label, { display: label });
          }
        });
      } else if (Array.isArray(link?.streetNames)) {
        link.streetNames.forEach(name => {
          if (!name) return;
          const label = String(name);
          if (!uniqueStreets.has(label)) {
            uniqueStreets.set(label, { display: label });
          }
        });
      }
    });

    aggregatedNodes.push({
      id: aggregateId,
      name: `${aggregateSize} ערים נוספות`,
      displayName: `${aggregateSize} ערים נוספות`,
      aggregated: true,
      aggregateTarget: targetId,
      aggregateSize,
      aggregateCityIds,
      aggregateCityNames,
      honorsOut: aggregateSize,
      honorsIn: 0,
      honorStreetOut: streetTotal,
      honorStreetIn: 0
    });

    aggregatedLinks.push({
      source: aggregateId,
      target: targetId,
      streetCount: streetTotal,
      streets: Array.from(uniqueStreets.values()).slice(0, 8),
      aggregated: true,
      aggregateSize,
      aggregateCityIds,
      aggregateCityNames
    });

    validEntries.forEach(entry => {
      nodesToRemove.add(entry.node.id);
    });
  });

  const finalNodes = filteredNodes.filter(node => !nodesToRemove.has(node.id));
  const finalLinks = filteredLinks.filter(
    link => !nodesToRemove.has(String(link.source)) && !nodesToRemove.has(String(link.target))
  );

  finalNodes.push(...aggregatedNodes);
  finalLinks.push(...aggregatedLinks);

  const preparedGraph = {
    nodes: finalNodes,
    links: finalLinks,
    stats
  };

  const nodesById = new Map(preparedGraph.nodes.map(node => [node.id, node]));

  return {
    graph: preparedGraph,
    nodesById,
    pathEdgeKeys,
    cycleEdgeKeys,
    pathNodeIds,
    cycleNodeIds
  };
}

function renderHome(force = false) {
  if (force) {
    state.rendered.networkPreview = false;
    state.rendered.heatmap = false;
  }
  console.time('[viz] renderHome');
  console.info('[viz] renderHome start');
  renderNetworkPreview(force);
  renderHeatmap(force);
  renderTopCitiesList();
  console.info('[viz] renderHome end');
  console.timeEnd('[viz] renderHome');
}

function getTopCities(limit = 40) {
  return state.cities
    .slice()
    .sort((a, b) => b.streetCount - a.streetCount)
    .slice(0, limit);
}

function createCommunityColorScale(values) {
  const unique = Array.from(new Set(values.filter(value => value !== null && value !== undefined)))
    .sort((a, b) => a - b);
  if (!unique.length) return null;

  let palette = [];
  if (unique.length <= 10 && Array.isArray(d3.schemeTableau10)) {
    palette = d3.schemeTableau10.slice(0, unique.length);
  } else if (unique.length <= 12 && Array.isArray(d3.schemeSet3)) {
    palette = d3.schemeSet3.slice(0, unique.length);
  } else {
    palette = d3.quantize(t => d3.interpolateRainbow(t * 0.92), unique.length);
  }

  return d3.scaleOrdinal().domain(unique).range(palette);
}

function clampNodeToBounds(node, width, height, margin) {
  node.x = Math.max(margin, Math.min(width - margin, node.x ?? width / 2));
  node.y = Math.max(margin, Math.min(height - margin, node.y ?? height / 2));
  return node;
}

function renderNetworkGraph(target, options = {}) {
  const container = target;
  if (!container) {
    console.warn('[viz] network container missing');
    return;
  }

  const {
    limit = 50,
    maxLinks = 350,
    height: forcedHeight = null,
    cacheKey = '',
    layout = (state.graphSettings && state.graphSettings.layout) || 'force',
    metric = (state.graphSettings && state.graphSettings.metric) || 'weightedJaccard'
  } = options;

  let metricKey = typeof metric === 'string' ? metric : 'weightedJaccard';
  if (metricKey === 'weighted') {
    metricKey = 'weightedJaccard';
  }
  if (metricKey !== 'weightedJaccard' && metricKey !== 'jaccard') {
    console.warn('[viz] unsupported metric requested, defaulting to weightedJaccard', { metric });
    metricKey = 'weightedJaccard';
  }

  const metricDisplayName = metricKey === 'weightedJaccard' ? 'Jaccard משוקלל' : 'Jaccard רגיל';

  console.info('[viz] renderNetworkGraph start', { limit, maxLinks, cacheKey, layout, metric: metricKey });

  const cities = getTopCities(limit);
  if (!cities.length) {
    container.innerHTML = '<p class="empty-state">לא נמצאו ערים להצגה.</p>';
    return;
  }

  container.innerHTML = '';

  const allowed = new Set(cities.map(city => city.id));
  const nodes = cities.map(city => ({
    id: city.id,
    name: city.name,
    streetCount: city.streetCount,
    community: typeof city.community === 'number' ? city.community : null
  }));

  const hasCommunityAnnotations = nodes.some(node => node.community !== null && node.community !== undefined);
  const requestedLayout = layout || 'force';
  const layoutMode = requestedLayout === 'community' && !hasCommunityAnnotations ? 'force' : requestedLayout;

  const links = [];
  const linkPairs = new Set();

  nodes.forEach(node => {
    const neighbors = state.similarityTop.get(node.id) || [];
    const sortedNeighbors = [...neighbors].sort((a, b) => {
      const aWeight = Number(a?.[metricKey] || 0);
      const bWeight = Number(b?.[metricKey] || 0);
      return bWeight - aWeight;
    });

    sortedNeighbors.forEach(neighbor => {
      const targetId = String(neighbor.city || '');
      if (!targetId || !allowed.has(targetId)) return;
      const weight = Number(neighbor?.[metricKey] || 0);
      if (weight <= 0) return;
      const key = node.id < targetId ? `${node.id}-${targetId}` : `${targetId}-${node.id}`;
      if (linkPairs.has(key)) return;
      linkPairs.add(key);
      links.push({
        source: node.id,
        target: targetId,
        weight,
        shared: neighbor.intersectionSize,
        weightedJaccard: Number(neighbor.weightedJaccard || 0),
        jaccard: Number(neighbor.jaccard || 0)
      });
    });
  });

  links.sort((a, b) => b.weight - a.weight);
  const linkCap = Math.min(maxLinks, Math.max(1, nodes.length * 7));
  const trimmedLinks = links.slice(0, linkCap);

  const adjacency = new Map();
  const ensureNeighborSet = id => {
    const key = String(id);
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    return adjacency.get(key);
  };

  trimmedLinks.forEach(link => {
    const sourceId = String(link.source);
    const targetId = String(link.target);
    link.sourceId = sourceId;
    link.targetId = targetId;
    ensureNeighborSet(sourceId).add(targetId);
    ensureNeighborSet(targetId).add(sourceId);
  });

  const baseLayoutKey = cacheKey || `${limit}-${maxLinks}`;
  const layoutKey = `${baseLayoutKey}|${layoutMode}|${metricKey}`;
  const cachedLayout = state.graphLayouts.get(layoutKey) || null;
  if (cachedLayout) {
    nodes.forEach(node => {
      const snapshot = cachedLayout[node.id];
      if (snapshot) {
        node.x = snapshot.x;
        node.y = snapshot.y;
      }
    });
  }

  const rect = container.getBoundingClientRect();
  const width = Math.max(rect.width || container.clientWidth || 600, 320);
  const resolvedHeight = forcedHeight ?? Math.max(rect.height || container.clientHeight || 0, 420);
  const margin = 48;

  const communityKeyFor = node =>
    node.community === null || node.community === undefined ? '__other__' : String(node.community);

  let communityCenters = null;
  if (layoutMode === 'community') {
    const communityKeys = Array.from(new Set(nodes.map(node => communityKeyFor(node))));
    const safeLength = Math.max(communityKeys.length, 1);
    communityKeys.sort((a, b) => {
      if (a === '__other__') return 1;
      if (b === '__other__') return -1;
      const numA = Number(a);
      const numB = Number(b);
      if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
        return numA - numB;
      }
      return String(a).localeCompare(String(b));
    });
    const columns = Math.ceil(Math.sqrt(safeLength));
    const rows = Math.ceil(safeLength / Math.max(columns, 1));
    const cellWidth = (width - margin * 2) / Math.max(columns, 1);
    const cellHeight = (resolvedHeight - margin * 2) / Math.max(rows, 1);
    communityCenters = new Map(
      communityKeys.map((key, index) => {
        const column = index % Math.max(columns, 1);
        const row = Math.floor(index / Math.max(columns, 1));
        return [
          key,
          {
            x: margin + cellWidth * (column + 0.5),
            y: margin + cellHeight * (row + 0.5)
          }
        ];
      })
    );
  }

  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${resolvedHeight}`)
    .attr('width', width)
    .attr('height', resolvedHeight)
    .attr('preserveAspectRatio', 'xMidYMid meet')
    .classed('network-graph', true);

  const tooltip = d3
    .select(container)
    .append('div')
    .attr('class', 'viz-tooltip');

  const radiusScale = d3
    .scaleSqrt()
    .domain(d3.extent(nodes, d => d.streetCount) || [1, 1])
    .range([6, 24]);

  const linkScale = d3
    .scaleLinear()
    .domain(d3.extent(trimmedLinks, d => d.weight) || [0, 0.1])
    .range([1, 5]);

  const communityScale = createCommunityColorScale(nodes.map(node => node.community));
  const fallbackScale = d3
    .scaleSequential(d3.interpolateCool)
    .domain(d3.extent(nodes, d => d.streetCount) || [1, 1]);

  const colorForNode = node =>
    communityScale ? communityScale(node.community) : fallbackScale(node.streetCount);

  const chargeStrength = layoutMode === 'community' ? -70 : -90;
  const axisStrength = layoutMode === 'community' ? 0.18 : 0.06;
  const collisionPadding = layoutMode === 'community' ? 10 : 8;
  const linkDistance = layoutMode === 'community'
    ? (d => Math.max(55, 180 - d.weight * 820))
    : (d => Math.max(70, 200 - d.weight * 880));
  const linkStrength = layoutMode === 'community'
    ? (d => Math.max(0.22, d.weight * 2.1))
    : (d => Math.max(0.18, d.weight * 1.9));
  const xForce = layoutMode === 'community'
    ? d3.forceX(node => {
        const center = communityCenters && communityCenters.get(communityKeyFor(node));
        return center ? center.x : width / 2;
      }).strength(axisStrength)
    : d3.forceX(width / 2).strength(axisStrength);
  const yForce = layoutMode === 'community'
    ? d3.forceY(node => {
        const center = communityCenters && communityCenters.get(communityKeyFor(node));
        return center ? center.y : resolvedHeight / 2;
      }).strength(axisStrength)
    : d3.forceY(resolvedHeight / 2).strength(axisStrength);

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      'link',
      d3
        .forceLink(trimmedLinks)
        .id(d => d.id)
        .distance(linkDistance)
        .strength(linkStrength)
    )
    .force('charge', d3.forceManyBody().strength(chargeStrength))
    .force('center', d3.forceCenter(width / 2, resolvedHeight / 2))
    .force('collision', d3.forceCollide(d => radiusScale(d.streetCount) + collisionPadding))
    .force('x', xForce)
    .force('y', yForce)
    .alphaDecay(0.12)
    .velocityDecay(0.32)
    .stop();

  const link = svg
    .append('g')
    .attr('class', 'graph-links')
    .attr('stroke-linecap', 'round')
    .selectAll('line')
    .data(trimmedLinks)
    .enter()
    .append('line')
    .attr('class', 'graph-link')
    .attr('stroke', 'rgba(148,163,255,0.28)')
    .attr('stroke-width', d => linkScale(d.weight));

  const node = svg
    .append('g')
    .attr('class', 'graph-nodes')
    .selectAll('circle')
    .data(nodes)
    .enter()
    .append('circle')
    .attr('class', 'graph-node')
    .attr('r', d => radiusScale(d.streetCount))
    .attr('fill', colorForNode)
    .attr('stroke', 'rgba(15,23,42,0.85)')
    .attr('stroke-width', 1.6);

  const labels = svg
    .append('g')
    .attr('class', 'graph-labels')
    .selectAll('text')
    .data(nodes)
    .enter()
    .append('text')
    .attr('class', 'graph-label')
    .text(d => d.name)
    .attr('text-anchor', 'middle')
    .attr('alignment-baseline', 'middle')
    .attr('fill', '#e2e8f0')
    .attr('font-size', '0.8rem')
    .attr('pointer-events', 'none');

  const snapshotLayout = () => {
    if (!layoutKey) return;
    const snapshot = Object.create(null);
    nodes.forEach(nodeData => {
      snapshot[nodeData.id] = { x: nodeData.x, y: nodeData.y };
    });
    state.graphLayouts.set(layoutKey, snapshot);
  };

  const updatePositions = () => {
    nodes.forEach(nodeData => clampNodeToBounds(nodeData, width, resolvedHeight, margin));
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);

    labels
      .attr('x', d => d.x)
      .attr('y', d => d.y - radiusScale(d.streetCount) - 6);
  };

  const warmupIterations = cachedLayout
    ? Math.min(60, Math.max(20, Math.round(nodes.length * 0.6)))
    : Math.min(240, Math.max(80, Math.round(nodes.length * 1.4)));

  for (let i = 0; i < warmupIterations; i += 1) {
    simulation.tick();
  }
  updatePositions();
  if (!cachedLayout) {
    snapshotLayout();
  }

  const setHighlight = focusId => {
    const key = focusId ? String(focusId) : '';
    const neighbors = key ? adjacency.get(key) || new Set() : null;

    node
      .classed('is-focused', d => key === d.id)
      .classed('is-neighbor', d => !!neighbors && neighbors.has(d.id))
      .classed('is-dimmed', d => !!key && key !== d.id && !(neighbors && neighbors.has(d.id)));

    labels.classed(
      'is-dimmed',
      d => !!key && key !== d.id && !(neighbors && neighbors.has(d.id))
    );

    link
      .classed('is-focused', d => d.sourceId === key || d.targetId === key)
      .classed(
        'is-neighbor',
        d => !!key && neighbors && (neighbors.has(d.sourceId) || neighbors.has(d.targetId))
      )
      .classed('is-dimmed', d => {
        if (!key) return false;
        if (d.sourceId === key || d.targetId === key) return false;
        return !(neighbors && (neighbors.has(d.sourceId) || neighbors.has(d.targetId)));
      });
  };

  const formatTooltip = (nodeData, neighborsList) => {
    const sortedNeighbors = [...neighborsList].sort((a, b) => {
      const aScore = Number(a?.[metricKey] || 0);
      const bScore = Number(b?.[metricKey] || 0);
      return bScore - aScore;
    });
    const topNeighbors = sortedNeighbors.filter(item => Number(item?.[metricKey] || 0) > 0).slice(0, 3);
    const neighborsMarkup = topNeighbors.length
      ? `<div style="margin-top:0.3rem;">דומות מובילות (${metricDisplayName}):<br>${topNeighbors
          .map(item => {
            const label = state.cityMap.get(item.city)?.name || item.city;
            const score = Number(item?.[metricKey] || 0).toFixed(3);
            return `${label} (${score})`;
          })
          .join('<br>')}</div>`
      : '';
    const communityLine =
      nodeData.community !== null && nodeData.community !== undefined
        ? `<div>קהילה: ${nodeData.community + 1}</div>`
        : '';

    return `
      <div><strong>${nodeData.name}</strong></div>
      <div>מספר רחובות: ${nodeData.streetCount.toLocaleString()}</div>
      ${communityLine}
      ${neighborsMarkup}
    `;
  };

  let activeHoverId = null;

  node
    .call(
      d3
        .drag()
        .on('start', event => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        })
        .on('drag', event => {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        })
        .on('end', event => {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
          setTimeout(snapshotLayout, 0);
        })
    )
    .on('mouseenter', (event, d) => {
      activeHoverId = d.id;
      setHighlight(d.id);
      const best = state.similarityTop.get(d.id) || [];
      tooltip
        .style('opacity', 1)
        .html(formatTooltip(d, best))
        .style('top', `${event.offsetY - 10}px`)
        .style('left', `${event.offsetX - 10}px`);
    })
    .on('mousemove', event => {
      tooltip
        .style('top', `${event.offsetY - 10}px`)
        .style('left', `${event.offsetX - 10}px`);
    })
    .on('mouseleave', event => {
      const leavingId = event.currentTarget && event.currentTarget.__data__ ? event.currentTarget.__data__.id : null;
      if (activeHoverId && leavingId && activeHoverId !== leavingId) {
        return;
      }
      const nextNode = event.relatedTarget && typeof event.relatedTarget.closest === 'function'
        ? event.relatedTarget.closest('.graph-node')
        : null;
      if (nextNode) {
        return;
      }
      activeHoverId = null;
      setHighlight(null);
      tooltip.style('opacity', 0);
    })
    .on('click', (_, d) => {
      window.location.hash = `#/city/${d.id}`;
    });

  svg.on('mouseleave', () => {
    activeHoverId = null;
    setHighlight(null);
    tooltip.style('opacity', 0);
  });

  simulation.on('tick', updatePositions);
  simulation.on('end', snapshotLayout);

  console.info('[viz] renderNetworkGraph end', {
    nodes: nodes.length,
    links: trimmedLinks.length,
    communities: communityScale ? communityScale.domain().length : 0,
    cacheHit: Boolean(cachedLayout),
    metric: metricKey
  });
}
function renderNetworkPreview(force = false) {
  const container = elements.home.network;
  if (!container) return;
  if (!force && state.rendered.networkPreview) return;
  renderNetworkGraph(container, {
    limit: 40,
    maxLinks: 240,
    cacheKey: 'preview',
    layout: state.graphSettings.layout,
    metric: state.graphSettings.metric
  });
  state.rendered.networkPreview = true;
}

function renderGraphView(force = false) {
  const container = elements.graph.canvas;
  if (!container) return;
  if (!force && state.rendered.graphFull) return;
  const bounds = container.getBoundingClientRect();
  const height = Math.max(bounds.height || container.clientHeight || 0, 620);
  renderNetworkGraph(container, {
    limit: 120,
    maxLinks: 720,
    height,
    cacheKey: 'graph-full',
    layout: state.graphSettings.layout,
    metric: state.graphSettings.metric
  });
  state.rendered.graphFull = true;
}


function renderCityDedicationSummary(graphData) {
  const container = elements.dedications.summary;
  if (!container) return;
  if (!graphData || !graphData.stats || !Array.isArray(graphData.nodes) || !graphData.nodes.length) {
    container.innerHTML = '<p class="empty-state">לא נמצאו קשרי הנצחה בין ערים.</p>';
    return;
  }

  const { stats } = graphData;
  const cityCount = stats.cityCount || 0;
  const edgeCount = stats.edgeCount || 0;
  const streetRefs = stats.streetReferenceCount || 0;
  const average = cityCount ? (streetRefs / cityCount).toFixed(1) : '0.0';

  const blocks = [
    {
      label: 'ערים ברשת',
      value: cityCount,
      note: 'ערים שמנציחות או מונצחות'
    },
    {
      label: 'קשתות הנצחה',
      value: edgeCount,
      note: 'עיר → עיר אחרת'
    },
    {
      label: 'סה"כ אזכורי רחובות',
      value: streetRefs,
      note: `ממוצע ${average} שמות רחוב לעיר`
    }
  ];

  container.innerHTML = blocks
    .map(block => `
      <div class="summary-block">
        <span class="summary-label">${block.label}</span>
        <span class="summary-value">${block.value}</span>
        <span class="summary-note">${block.note}</span>
      </div>
    `)
    .join('');
}

function renderCityChainSequence(container, entry, fallbackMessage) {
  if (!container) return;
  container.innerHTML = '';
  container.classList.remove('empty');

  if (!entry || !Array.isArray(entry.cities) || entry.cities.length <= 1) {
    container.textContent = fallbackMessage;
    container.classList.add('empty');
    return;
  }

  const cityIds = entry.cities.map(cityId => String(cityId));
  const cityNames = cityIds.map((cityId, index) => {
    if (entry.cityNames && entry.cityNames[index]) {
      return entry.cityNames[index];
    }
    return state.cityMap.get(cityId)?.name || state.cityHonors.nodesById.get(cityId)?.name || cityId;
  });

  const edges = Array.isArray(entry.edges) ? entry.edges : [];
  const isCycle = cityIds.length > 1 && cityIds[0] === cityIds[cityIds.length - 1];
  const steps = edges.length || Math.max(0, cityIds.length - (isCycle ? 0 : 1));

  const summary = document.createElement('div');
  summary.className = 'chain-sequence-meta';
  summary.innerHTML = `
    <span><strong>${cityIds.length}</strong> ערים</span>
    <span>·</span>
    <span><strong>${steps}</strong> מעברי הנצחה</span>
  `;

  if (cityNames.length >= 2) {
    const startName = cityNames[0];
    const endName = cityNames[cityNames.length - 1];
    const range = document.createElement('span');
    range.className = 'chain-sequence-range';
    if (isCycle && startName === endName) {
      range.textContent = `מעגל שמתחיל ומסתיים ב-${startName}`;
    } else {
      range.textContent = `מתחיל ב-${startName} ומסתיים ב-${endName}`;
    }
    summary.appendChild(range);
  }

  container.appendChild(summary);

  const fragment = document.createDocumentFragment();

  edges.forEach((edge, index) => {
    const fromIndex = Math.min(index, cityIds.length - 1);
    const toIndex = index + 1 < cityIds.length ? index + 1 : (isCycle ? (index + 1) % cityIds.length : index + 1);
    const fromId = cityIds[fromIndex];
    const toId = cityIds[toIndex] || String(edge?.target ?? '');
    const fromName = cityNames[fromIndex] || state.cityMap.get(fromId)?.name || fromId;
    const toName = cityNames[toIndex] || state.cityMap.get(toId)?.name || state.cityHonors.nodesById.get(toId)?.name || toId;

    const step = document.createElement('div');
    step.className = 'chain-step';

    const indexBadge = document.createElement('span');
    indexBadge.className = 'chain-step-index';
    indexBadge.textContent = String(index + 1);
    step.appendChild(indexBadge);

    const cityBlock = document.createElement('div');
    cityBlock.className = 'chain-step-cities';

    const fromLabel = document.createElement('span');
    fromLabel.className = 'chain-step-city from';
    fromLabel.textContent = fromName;

    const arrow = document.createElement('span');
    arrow.className = 'chain-step-arrow';
    arrow.textContent = '⇢';

    const toLabel = document.createElement('span');
    toLabel.className = 'chain-step-city to';
    toLabel.textContent = toName;

    cityBlock.append(fromLabel, arrow, toLabel);
    step.appendChild(cityBlock);

    const details = document.createElement('div');
    details.className = 'chain-step-details';

    const rawCount = Number(edge?.streetCount || 0);
    const streetCount = rawCount > 0
      ? rawCount
      : Array.isArray(edge?.streetNames)
        ? edge.streetNames.length
        : Array.isArray(edge?.streets)
          ? edge.streets.length
          : 1;
    const countLabel = streetCount === 1 ? 'רחוב אחד' : `${streetCount} רחובות`;
    const countBadge = document.createElement('span');
    countBadge.className = 'chain-step-count';
    countBadge.textContent = countLabel;
    details.appendChild(countBadge);

    const exampleNames = [];
    if (Array.isArray(edge?.streetNames)) {
      edge.streetNames.forEach(name => {
        if (!name) return;
        exampleNames.push(String(name));
      });
    } else if (Array.isArray(edge?.streets)) {
      edge.streets.forEach(street => {
        const label = street?.display || street?.name;
        if (!label) return;
        exampleNames.push(String(label));
      });
    }

    if (exampleNames.length) {
      const unique = Array.from(new Set(exampleNames)).slice(0, 4);
      const example = document.createElement('span');
      example.className = 'chain-step-examples';
      example.textContent = `דוגמאות: ${unique.join(' · ')}`;
      details.appendChild(example);
    }

    step.appendChild(details);
    fragment.appendChild(step);
  });

  container.appendChild(fragment);
}

function getHonorNodeRadius(node) {
  if (!node) return 18;
  const totalStreets = Number(node.honorStreetOut || 0) + Number(node.honorStreetIn || 0);
  if (node.aggregated) {
    const fallback = node.aggregateSize || 1;
    return 16 + Math.sqrt(totalStreets || fallback) * 2.4;
  }
  return 18 + Math.sqrt(totalStreets || 1) * 3;
}

function renderCityHonorGraph(force = false) {
  const container = elements.dedications.graph;
  if (!container) return;
  if (!force && state.rendered.cityHonors) return;

  container.innerHTML = '';

  const graphData = state.cityHonors.graph;
  if (!graphData || !Array.isArray(graphData.nodes) || !graphData.nodes.length) {
    container.innerHTML = '<p class="empty-state">אין נתונים להצגה. הריצו את תהליך העיבוד כדי ליצור את הקובץ city_name_graph.json.</p>';
    return;
  }

  const bounds = container.getBoundingClientRect();
  const width = Math.max(bounds.width || container.clientWidth || 0, 720);
  const height = Math.max(bounds.height || 0, 520);

  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const defs = svg.append('defs');
  const markerConfigs = [
    { id: 'chain-arrow', color: 'rgba(148,163,255,0.65)' },
    { id: 'chain-arrow-path', color: '#22d3ee' },
    { id: 'chain-arrow-cycle', color: '#facc15' }
  ];

  markerConfigs.forEach(config => {
    defs
      .append('marker')
      .attr('id', config.id)
      .attr('orient', 'auto')
      .attr('markerWidth', 10)
      .attr('markerHeight', 10)
      .attr('refX', 12)
      .attr('refY', 3)
      .attr('viewBox', '0 0 12 6')
      .append('path')
      .attr('d', 'M0,0 L12,3 L0,6 Z')
      .attr('fill', config.color);
  });

  const nodes = graphData.nodes.map(node => ({ ...node }));
  const links = graphData.links.map(link => ({
    ...link,
    source: link.source,
    target: link.target,
    _source: link.source,
    _target: link.target
  }));

  const pathEdgeKeys = state.cityHonors.pathEdgeKeys || new Set();
  const cycleEdgeKeys = state.cityHonors.cycleEdgeKeys || new Set();
  const pathNodeIds = state.cityHonors.pathNodeIds || new Set();
  const cycleNodeIds = state.cityHonors.cycleNodeIds || new Set();

  const linkGroup = svg.append('g').attr('class', 'chain-links');
  const nodeGroup = svg.append('g').attr('class', 'chain-nodes');

  const linkSelection = linkGroup
    .selectAll('line')
    .data(links)
    .enter()
    .append('line')
    .attr('class', d => {
      const key = makeEdgeKey(d._source, d._target);
      const classes = ['chain-link'];
      if (pathEdgeKeys.has(key)) classes.push('is-path');
      if (cycleEdgeKeys.has(key)) classes.push('is-cycle');
      if (d.aggregated) classes.push('is-aggregate');
      return classes.join(' ');
    })
    .attr('stroke-width', d => {
      const count = Number(d.streetCount || 0);
      const fallback = Array.isArray(d.streets) ? d.streets.length : 1;
      return 1.2 + Math.min(count > 0 ? count : fallback, 6) * 0.8;
    })
    .attr('marker-end', d => {
      const key = makeEdgeKey(d._source, d._target);
      if (pathEdgeKeys.has(key)) return 'url(#chain-arrow-path)';
      if (cycleEdgeKeys.has(key)) return 'url(#chain-arrow-cycle)';
      return 'url(#chain-arrow)';
    });

  linkSelection.append('title').text(d => {
    const sourceName = state.cityMap.get(d._source)?.name || state.cityHonors.nodesById.get(d._source)?.name || d._source;
    const targetName = state.cityMap.get(d._target)?.name || state.cityHonors.nodesById.get(d._target)?.name || d._target;
    const rawCount = Number(d.streetCount || 0);
    const computedCount = rawCount > 0 ? rawCount : Array.isArray(d.streets) ? d.streets.length : 1;
    const base = computedCount === 1 ? 'רחוב אחד' : `${computedCount} רחובות`;
    const names = Array.isArray(d.streets)
      ? d.streets.map(street => street?.display).filter(Boolean).slice(0, 4)
      : [];

    if (d.aggregated) {
      const cityNames = Array.isArray(d.aggregateCityNames)
        ? d.aggregateCityNames.slice(0, 6)
        : [];
      const extraCities = Array.isArray(d.aggregateCityNames) && d.aggregateCityNames.length > 6
        ? `ועוד ${d.aggregateCityNames.length - 6}`
        : '';
      const lines = [
        `${d.aggregateSize === 1 ? 'עיר אחת' : `${d.aggregateSize} ערים`} מנציחות את ${targetName}`,
        base
      ];
      if (cityNames.length) {
        lines.push(cityNames.join(', '));
      }
      if (extraCities) {
        lines.push(extraCities);
      }
      if (names.length) {
        lines.push(`דוגמאות: ${names.join(', ')}`);
      }
      return lines.filter(Boolean).join('\n');
    }

    return names.length
      ? `${sourceName} → ${targetName}\n${base}: ${names.join(', ')}`
      : `${sourceName} → ${targetName}\n${base}`;
  });

  const nodeSelection = nodeGroup
    .selectAll('g')
    .data(nodes)
    .enter()
    .append('g')
    .attr('class', d => {
      const classes = ['chain-node'];
      if (pathNodeIds.has(d.id)) classes.push('is-path');
      if (cycleNodeIds.has(d.id)) classes.push('is-cycle');
      if (d.aggregated) classes.push('is-aggregate');
      return classes.join(' ');
    })
    .call(
      d3
        .drag()
        .on('start', event => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        })
        .on('drag', event => {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        })
        .on('end', event => {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        })
    );

  nodeSelection
    .append('circle')
    .attr('r', d => getHonorNodeRadius(d));

  nodeSelection
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .text(d => d.name || d.displayName || d.id);

  nodeSelection.append('title').text(d => {
    const honorsOut = d.honorsOut || 0;
    const honorsIn = d.honorsIn || 0;
    const streetOut = d.honorStreetOut || 0;
    const streetIn = d.honorStreetIn || 0;
    if (d.aggregated) {
      const targetName = state.cityMap.get(d.aggregateTarget)?.name || state.cityHonors.nodesById.get(d.aggregateTarget)?.name || d.aggregateTarget;
      const size = d.aggregateSize || (Array.isArray(d.aggregateCityNames) ? d.aggregateCityNames.length : 0) || 1;
      const label = size === 1 ? 'עיר אחת' : `${size} ערים`;
      const names = Array.isArray(d.aggregateCityNames) ? d.aggregateCityNames.slice(0, 6).join(', ') : '';
      return names
        ? `${label} שמנציחות את ${targetName}\n${names}`
        : `${label} שמנציחות את ${targetName}`;
    }
    return `${d.name || d.id}\nמנציחה ${honorsOut} ערים (${streetOut} שמות רחובות)\nמונצחת ב-${honorsIn} ערים (${streetIn} שמות)`;
  });

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      'link',
      d3
        .forceLink(links)
        .id(d => d.id)
        .distance(d => 150 - Math.min(d.streetCount || (d.streets ? d.streets.length : 1), 5) * 8)
        .strength(0.4)
    )
    .force('charge', d3.forceManyBody().strength(-420))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => getHonorNodeRadius(d) + 8));

  simulation.on('tick', () => {
    nodes.forEach(node => clampNodeToBounds(node, width, height, 40));
    linkSelection
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    nodeSelection.attr('transform', d => `translate(${d.x}, ${d.y})`);
  });

  simulation.alpha(1).restart();
}

function renderCityDedicationView(force = false) {
  const graphData = state.cityHonors.graph;
  if (!graphData || !Array.isArray(graphData.nodes) || !graphData.nodes.length) {
    if (elements.dedications.summary) {
      elements.dedications.summary.innerHTML = '<p class="empty-state">לא נמצאו קשרים בין ערים. הריצו את תהליך העיבוד כדי ליצור נתונים.</p>';
    }
    if (elements.dedications.graph) {
      elements.dedications.graph.innerHTML = '<p class="empty-state">הגרף יופיע כאן לאחר יצירת הקובץ city_name_graph.json.</p>';
    }
    if (elements.dedications.path) {
      elements.dedications.path.textContent = 'לא נמצא מסלול הנצחה מרובה ערים.';
      elements.dedications.path.classList.add('empty');
    }
    if (elements.dedications.cycle) {
      elements.dedications.cycle.textContent = 'לא נמצא מעגל הנצחה בין ערים.';
      elements.dedications.cycle.classList.add('empty');
    }
    state.rendered.cityHonors = true;
    return;
  }

  if (!force && state.rendered.cityHonors) return;

  renderCityDedicationSummary(graphData);
  renderCityHonorGraph(true);

  const pathEntry = graphData.stats?.longestPath || null;
  const cycleEntry = graphData.stats?.longestCycle || null;

  renderCityChainSequence(elements.dedications.path, pathEntry, 'לא נמצא מסלול הנצחה מרובה ערים.');
  renderCityChainSequence(elements.dedications.cycle, cycleEntry, 'לא נמצא מעגל שבו כל עיר מנציחה את הבאה וחוזרת לעצמה.');

  state.rendered.cityHonors = true;
}


function renderHeatmap(force = false) {
  const container = elements.home.heatmap;
  if (!container) {
    console.warn('[viz] heatmap container missing');
    return;
  }
  if (!force && state.rendered.heatmap) {
    return;
  }
  console.info('[viz] renderHeatmap start');
  container.innerHTML = '';

  const cities = getTopCities(5);
  if (!cities.length) {
    container.innerHTML = '<p class="empty-state">לא נמצאו ערים לחישוב מטריצה.</p>';
    return;
  }

  const data = [];
  cities.forEach((rowCity, rowIndex) => {
    cities.forEach((colCity, colIndex) => {
      const similarity = getSimilarityMetric(rowCity.id, colCity.id, 'weightedJaccard');
      data.push({
        x: colIndex,
        y: rowIndex,
        value: similarity,
        row: rowCity,
        column: colCity
      });
    });
  });

  const size = Math.min(container.clientWidth || 600, 620);
  const margin = { top: 60, right: 20, bottom: 20, left: 20 };
  const cellSize = (size - margin.left - margin.right) / cities.length;

  const svg = d3
    .select(container)
    .append('svg')
    .attr('width', size)
    .attr('height', size);

  console.debug('[viz] heatmap svg size', size);

  const group = svg
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  const color = d3
    .scaleSequential(d3.interpolateYlGnBu)
    .domain([0, d3.max(data, d => d.value) || 0.05]);

  const tooltip = d3
    .select(container)
    .append('div')
    .attr('class', 'viz-tooltip');

  group
    .selectAll('rect')
    .data(data)
    .enter()
    .append('rect')
    .attr('x', d => d.x * cellSize)
    .attr('y', d => d.y * cellSize)
    .attr('width', cellSize - 2)
    .attr('height', cellSize - 2)
    .attr('rx', 6)
    .attr('ry', 6)
    .attr('fill', d => (d.value > 0 ? color(d.value) : 'rgba(148,163,255,0.1)'))
    .on('mouseenter', (event, d) => {
      tooltip
        .style('opacity', 1)
        .html(`
          <div><strong>${d.row.name}</strong> ⇆ <strong>${d.column.name}</strong></div>
          <div>מדד דמיון: ${d.value.toFixed(3)}</div>
        `);
    })
    .on('mousemove', event => {
      tooltip
        .style('top', `${event.offsetY - 10}px`)
        .style('left', `${event.offsetX - 10}px`);
    })
    .on('mouseleave', () => tooltip.style('opacity', 0))
    .on('click', (_, d) => {
      window.location.hash = `#/city/${d.row.id}/${d.column.id}`;
    });

  const axisGroup = svg.append('g').attr('transform', `translate(${margin.left}, ${margin.top - 10})`);

  axisGroup
    .selectAll('text.row')
    .data(cities)
    .enter()
    .append('text')
    .attr('class', 'row')
    .attr('x', (_, i) => i * cellSize + cellSize / 2)
    .attr('y', -14)
    .attr('text-anchor', 'middle')
    .attr('fill', '#e2e8f0')
    .attr('font-size', '0.88rem')
    .attr('font-weight', '600')
    .style('letter-spacing', '0.04em')
    .style('paint-order', 'stroke')
    .style('stroke', 'rgba(15,23,42,0.75)')
    .style('stroke-width', '4px')
    .style('stroke-linejoin', 'round')
    .text(city => city.name);

  svg
    .append('g')
    .attr('transform', `translate(${margin.left - 10}, ${margin.top})`)
    .selectAll('text.col')
    .data(cities)
    .enter()
    .append('text')
    .attr('class', 'col')
    .attr('x', -10)
    .attr('y', (_, i) => i * cellSize + cellSize / 2)
    .attr('text-anchor', 'end')
    .attr('alignment-baseline', 'middle')
    .attr('fill', '#e2e8f0')
    .attr('font-size', '0.88rem')
    .attr('font-weight', '600')
    .style('letter-spacing', '0.03em')
    .style('paint-order', 'stroke')
    .style('stroke', 'rgba(15,23,42,0.75)')
    .style('stroke-width', '4px')
    .style('stroke-linejoin', 'round')
    .text(city => city.name);

  state.rendered.heatmap = true;
  console.info('[viz] renderHeatmap end');
}

function renderTopCitiesList() {
  if (!elements.home.topList) return;
  const topCities = getTopCities(12);
  elements.home.topList.innerHTML = topCities
    .map(city => `
      <li>
        <strong>${city.name}</strong>
        <span class="count">${city.streetCount.toLocaleString()} רחובות</span>
      </li>
    `)
    .join('');
}

function renderCity(primaryId, secondaryId = '') {
  const city = state.cityMap.get(primaryId);
  if (!city) {
    setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, '');
    setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
    elements.city.summary.innerHTML = '<p>בחרו עיר כדי לראות את הנתונים.</p>';
    elements.city.chart.innerHTML = '';
    elements.city.similarList.innerHTML = '';
    elements.city.sharedList.innerHTML = '';
    elements.city.overlap.innerHTML = '';
    return;
  }

  setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, primaryId);

  const similarity = state.similarityTop.get(primaryId) || [];
  elements.city.summary.innerHTML = `
    <h2>${city.name}</h2>
    <div class="street-meta">
      <div>
        <div>מספר רחובות מנורמל:</div>
        <strong>${city.streetCount.toLocaleString()}</strong>
      </div>
      <div>
        <div>חיבורים משמעותיים:</div>
        <strong>${similarity.length}</strong>
      </div>
    </div>
  `;

  renderCityChart(city, similarity);
  const selectedPartnerId = secondaryId || (similarity[0]?.city ?? '');
  renderCitySimilarButtons(primaryId, similarity, selectedPartnerId);
  if (selectedPartnerId) {
    setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, selectedPartnerId);
  } else {
    setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
  }
  renderSharedStreets(primaryId, selectedPartnerId || null);
  renderOverlap(primaryId, selectedPartnerId || '');
}

function renderCityChart(city, similarity) {
  const container = elements.city.chart;
  if (!container) return;
  container.innerHTML = '';
  if (!similarity.length) {
    container.innerHTML = '<p>לא נמצאו ערים עם דמיון משמעותי.</p>';
    return;
  }

  const data = similarity.slice(0, 10);
  const width = container.clientWidth || 500;
  const height = 340;
  const margin = { top: 10, right: 20, bottom: 20, left: 120 };

  const svg = d3
    .select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  console.debug('[viz] network svg size', { width, height });

  const x = d3
    .scaleLinear()
    .domain([0, d3.max(data, d => d.weightedJaccard) || 0.1])
    .range([margin.left, width - margin.right]);

  const y = d3
    .scaleBand()
    .domain(data.map(item => item.city))
    .range([margin.top, height - margin.bottom])
    .padding(0.2);

  const color = d3.scaleSequential(d3.interpolatePlasma).domain([0, data.length]);

  svg
    .append('g')
    .selectAll('rect')
    .data(data)
    .enter()
    .append('rect')
    .attr('x', margin.left)
    .attr('y', d => y(d.city))
    .attr('height', y.bandwidth())
    .attr('width', d => x(d.weightedJaccard) - margin.left)
    .attr('fill', (_, i) => color(i))
    .attr('rx', 10)
    .on('click', (_, d) => {
      renderSharedStreets(city.id, d.city);
      setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, d.city);
      window.location.hash = `#/city/${city.id}/${d.city}`;
    });

  svg
    .append('g')
    .attr('transform', `translate(${margin.left}, 0)`)
    .call(
      d3
        .axisLeft(y)
        .tickFormat(id => state.cityMap.get(id)?.name || id)
    )
    .selectAll('text')
    .style('fill', '#e2e8f0');

  svg
    .append('g')
    .attr('transform', `translate(0, ${height - margin.bottom})`)
    .call(
      d3
        .axisBottom(x)
        .ticks(5)
        .tickFormat(value => value.toFixed(2))
    )
    .selectAll('text')
    .style('fill', '#e2e8f0');
}

function renderCitySimilarButtons(primaryId, similarity, activeCityId = '') {
  const container = elements.city.similarList;
  if (!container) return;
  container.innerHTML = '';
  if (!similarity.length) {
    container.innerHTML = '<p>אין ערים דומות להצגה.</p>';
    return;
  }

  const normalizedActiveId = activeCityId ? String(activeCityId) : '';
  similarity.slice(0, 12).forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cityId = item.city;
    const cityLabel = state.cityMap.get(item.city)?.name || item.city;
    button.textContent = cityLabel + ' (' + item.weightedJaccard.toFixed(3) + ')';
    button.addEventListener('click', () => {
      setActiveSimilarCity(item.city);
      setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, item.city);
      renderSharedStreets(primaryId, item.city);
      renderOverlap(primaryId, item.city);
      window.location.hash = '#/city/' + primaryId + '/' + item.city;
    });
    container.appendChild(button);
  });

  setActiveSimilarCity(normalizedActiveId);
}

function setActiveSimilarCity(partnerId) {
  const container = elements.city.similarList;
  if (!container) return;
  const buttons = Array.from(container.querySelectorAll('button'));
  if (!buttons.length) return;

  const normalized = partnerId ? String(partnerId) : '';
  let matched = false;

  buttons.forEach(button => {
    const isMatch = normalized && button.dataset.cityId === normalized;
    button.classList.toggle('active', Boolean(isMatch));
    if (isMatch) {
      matched = true;
    }
  });

  if (!normalized) {
    buttons.forEach(button => button.classList.remove('active'));
    buttons[0].classList.add('active');
    return;
  }

  if (!matched) {
    buttons.forEach(button => button.classList.remove('active'));
  }
}

function computeSharedStreetHighlights(primaryId, partnerId, limit = 20) {
  if (!primaryId || !partnerId) return null;
  const primary = state.cityMap.get(primaryId);
  const partner = state.cityMap.get(partnerId);
  if (!primary || !partner) return null;

  const partnerStreets = new Map((partner.streets || []).map(street => [street.key, street]));
  const overlaps = [];

  const rarityFor = street => {
    if (street && typeof street.rarityWeight === 'number' && Number.isFinite(street.rarityWeight)) {
      return street.rarityWeight;
    }
    const key = street?.key;
    const fallback = key ? state.rarityWeights[key] : undefined;
    return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0;
  };

  (primary.streets || []).forEach(street => {
    if (!street || !street.key) return;
    const partnerStreet = partnerStreets.get(street.key);
    if (!partnerStreet) return;
    const rarity = Math.max(rarityFor(street), rarityFor(partnerStreet));
    const display =
      street.display ||
      partnerStreet.display ||
      street.normDisplay ||
      partnerStreet.normDisplay ||
      street.key;
    overlaps.push({
      norm_key: street.key,
      display_name: display,
      rarity_weight: rarity
    });
  });

  if (!overlaps.length) {
    return null;
  }

  overlaps.sort((a, b) => b.rarity_weight - a.rarity_weight);

  const primaryKeys = new Set((primary.streets || []).map(item => item.key));
  const partnerKeys = new Set((partner.streets || []).map(item => item.key));
  const intersectionSize = overlaps.length;
  const unionSize = primaryKeys.size + partnerKeys.size - intersectionSize;

  return {
    city: partnerId,
    cityName: partner.name,
    weightedJaccard: getSimilarityMetric(primaryId, partnerId, 'weightedJaccard'),
    jaccard: unionSize > 0 ? intersectionSize / unionSize : 0,
    intersectionSize,
    unionSize,
    topSharedStreets: overlaps.slice(0, limit)
  };
}

function renderSharedStreets(primaryId, partnerId) {
  const container = elements.city.sharedList;
  if (!container) return;
  container.innerHTML = '';

  const normalizedPartner = partnerId ? String(partnerId) : '';
  setActiveSimilarCity(normalizedPartner);

  if (!normalizedPartner) {
    container.innerHTML = '<p>בחרו עיר להשוואה כדי לראות רחובות משותפים.</p>';
    return;
  }

  let entry = getSimilarityEntry(primaryId, normalizedPartner);
  if (!entry || !Array.isArray(entry.topSharedStreets) || !entry.topSharedStreets.length) {
    const fallback = computeSharedStreetHighlights(primaryId, normalizedPartner);
    if (fallback) {
      entry = entry ? { ...entry, topSharedStreets: fallback.topSharedStreets } : fallback;

      let primaryMap = state.similarityLookup.get(primaryId);
      if (!primaryMap) {
        primaryMap = new Map();
        state.similarityLookup.set(primaryId, primaryMap);
      }
      primaryMap.set(normalizedPartner, entry);

      let partnerMap = state.similarityLookup.get(normalizedPartner);
      if (!partnerMap) {
        partnerMap = new Map();
        state.similarityLookup.set(normalizedPartner, partnerMap);
      }
      if (!partnerMap.has(primaryId)) {
        partnerMap.set(primaryId, {
          ...entry,
          city: primaryId,
          cityName: state.cityMap.get(primaryId)?.name || entry.cityName || primaryId
        });
      }
    }
  }

  if (!entry || !Array.isArray(entry.topSharedStreets) || !entry.topSharedStreets.length) {
    container.innerHTML = '<p>לא נמצאו רחובות משותפים משמעותיים בין צמד הערים.</p>';
    return;
  }

  const list = document.createElement('ul');
  entry.topSharedStreets.forEach(street => {
    if (!street) return;
    const displayName =
      street.display_name ||
      street.display ||
      street.normDisplay ||
      street.norm_key ||
      street.key;
    const rarityValue = Number(street.rarity_weight);
    const rarity = Number.isFinite(rarityValue) ? rarityValue : 0;
    const rarityText = rarity.toFixed(2);
    const li = document.createElement('li');
    const template = [
      '<span>' + displayName + '</span>',
      '<small>משקל נדירות: ' + rarityText + '</small>'
    ].join('');
    li.innerHTML = template;
    const targetKey = street.norm_key || street.key || '';
    if (targetKey) {
      li.addEventListener('click', () => navigateToStreet(targetKey));
    }
    list.appendChild(li);
  });
  container.appendChild(list);
}

function renderOverlap(primaryId, secondaryId) {
  const container = elements.city.overlap;
  if (!container) return;
  container.innerHTML = '';
  if (!secondaryId) {
    container.innerHTML = '<p>בחרו עיר נוספת כדי להציג את רשימת החפיפה המלאה.</p>';
    return;
  }
  const primary = state.cityMap.get(primaryId);
  const secondary = state.cityMap.get(secondaryId);
  if (!primary || !secondary) {
    container.innerHTML = '<p>לא ניתן לטעון את הנתונים עבור אחת הערים.</p>';
    return;
  }

  const primaryKeys = new Set(primary.streets.map(street => street.key));
  const overlap = secondary.streets.filter(street => primaryKeys.has(street.key));
  if (!overlap.length) {
    container.innerHTML = '<p>אין רחובות משותפים בין צמד הערים.</p>';
    return;
  }

  const sorted = overlap
    .map(street => ({
      ...street,
      rarity: street.rarityWeight ?? state.rarityWeights[street.key] ?? 0
    }))
    .sort((a, b) => b.rarity - a.rarity)
    .slice(0, 150);

  const list = document.createElement('ul');
  sorted.forEach(street => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${street.display}</span>
      <div class="overlap-actions">
        <small>משקל נדירות: ${street.rarity.toFixed(3)}</small>
        <button type="button">לפרטי רחוב</button>
      </div>
    `;
    li.querySelector('button').addEventListener('click', () => navigateToStreet(street.key));
    list.appendChild(li);
  });
  container.appendChild(list);
}

function setupCityHandlers() {
  const primaryInput = elements.city.primarySelect;
  const primarySuggestions = elements.city.primarySuggestions;
  const secondaryInput = elements.city.secondarySelect;
  const secondarySuggestions = elements.city.secondarySuggestions;

  if (primaryInput && primarySuggestions) {
    wireCityAutocomplete(primaryInput, primarySuggestions, {
      onSelect: city => {
        const companionId = getSelectedCityId(secondaryInput);
        const hasCompanion = companionId && state.cityMap.has(companionId);
        const partnerId = hasCompanion ? companionId : '';
        renderCity(city.id, partnerId);
        const targetHash = partnerId ? `#/city/${city.id}/${partnerId}` : `#/city/${city.id}`;
        if (window.location.hash !== targetHash) {
          window.location.hash = targetHash;
        }
      },
      onClear: () => {
        renderCity('', '');
        if (secondaryInput) {
          setCityInputValue(secondaryInput, secondarySuggestions, '');
        }
        if (window.location.hash !== '#/city') {
          window.location.hash = '#/city';
        }
      }
    });
  }

  if (secondaryInput && secondarySuggestions) {
    wireCityAutocomplete(secondaryInput, secondarySuggestions, {
      onSelect: city => {
        const primaryId = getSelectedCityId(primaryInput);
        if (!primaryId) {
          setCityInputValue(primaryInput, primarySuggestions, city.id);
          renderCity(city.id, '');
          if (window.location.hash !== `#/city/${city.id}`) {
            window.location.hash = `#/city/${city.id}`;
          }
          return;
        }
        renderSharedStreets(primaryId, city.id);
        renderOverlap(primaryId, city.id);
        const targetHash = `#/city/${primaryId}/${city.id}`;
        if (window.location.hash !== targetHash) {
          window.location.hash = targetHash;
        }
      },
      onClear: () => {
        const primaryId = getSelectedCityId(primaryInput);
        if (!primaryId) return;
        renderSharedStreets(primaryId, '');
        renderOverlap(primaryId, '');
        const targetHash = `#/city/${primaryId}`;
        if (window.location.hash !== targetHash) {
          window.location.hash = targetHash;
        }
      }
    });
  }
}

function setupStreetSearch() {
  const performSearch = () => {
    const query = elements.street.searchInput.value.trim();
    if (!query || !state.fuse) return;
    const matches = state.fuse.search(query).slice(0, 20);
    renderStreetResults(matches, { autoSelectFirst: true, query });
  };

  elements.street.searchButton.addEventListener('click', performSearch);
  elements.street.searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      performSearch();
    }
  });
}

function setupGraphControls() {
  const layoutSelect = elements.graph.layoutSelect;
  if (layoutSelect) {
    layoutSelect.value = state.graphSettings.layout;
    layoutSelect.addEventListener('change', event => {
      const newLayout = (event.target && event.target.value) || 'force';
      if (state.graphSettings.layout === newLayout) return;
      state.graphSettings.layout = newLayout;
      state.rendered.graphFull = false;
      state.rendered.networkPreview = false;
      if (!state.ready) return;
      renderNetworkPreview(true);
      if (parseHash().view === 'graph') {
        renderGraphView(true);
      }
    });
  }

  const metricSelect = elements.graph.metricSelect;
  if (metricSelect) {
    metricSelect.value = state.graphSettings.metric;
    metricSelect.addEventListener('change', event => {
      const newMetric = (event.target && event.target.value) || 'weightedJaccard';
      if (state.graphSettings.metric === newMetric) return;
      state.graphSettings.metric = newMetric;
      state.graphLayouts.clear();
      state.rendered.graphFull = false;
      state.rendered.networkPreview = false;
      if (!state.ready) return;
      renderNetworkPreview(true);
      if (parseHash().view === 'graph') {
        renderGraphView(true);
      }
    });
  }
}

function navigateToStreet(streetKey, { scroll = true } = {}) {
  const resolvedKey = resolveStreetKey(streetKey);
  if (!resolvedKey) {
    console.warn('[street] unable to resolve street key', { streetKey });
    showToast('לא הצלחנו לפתוח את הרחוב שבחרתם.', 'error');
    return;
  }

  if (streetKey && streetKey !== resolvedKey) {
    state.streetKeyCache.set(String(streetKey).trim(), resolvedKey);
  }

  showView('street');
  setActiveNav('street');
  renderStreetDetails(resolvedKey, false);

  const targetHash = `#/street/${resolvedKey}`;
  if (window.location.hash !== targetHash) {
    window.location.hash = targetHash;
  }
  if (scroll && elements.street.details) {
    elements.street.details.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}


function renderStreetResults(matches, { autoSelectFirst = false, query = '' } = {}) {
  const container = elements.street.results;
  if (!container) return;
  if (!matches.length) {
    container.innerHTML = '<p>לא נמצאו תוצאות תואמות.</p>';
    return;
  }

  const list = document.createElement('ul');
  matches.forEach(result => {
    const data = result.item;
    const resolvedKey = resolveStreetKey(data.key);
    const entry = resolvedKey ? state.streetIndex.get(resolvedKey) : null;
    if (!entry) return;

    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'street-result-link';
    button.dataset.key = resolvedKey;
    button.innerHTML = `
      <strong>${entry.display}</strong>
      <div>מופיע ב-${entry.cityCount} ערים</div>
    `;
    const selectStreet = () => navigateToStreet(resolvedKey);
    button.addEventListener('click', selectStreet);
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectStreet();
      }
    });
    li.appendChild(button);
    list.appendChild(li);
  });

  container.innerHTML = '';
  container.appendChild(list);
}

function renderStreetDetails(streetKey, updateHash = true) {
  const container = elements.street.details;
  if (!container) return;
  const normalizedKey = state.streetIndex.has(streetKey) ? streetKey : resolveStreetKey(streetKey);
  if (!normalizedKey) {
    container.innerHTML = '<p>אין תוצאות עבור המפתח המבוקש.</p>';
    return;
  }
  const entry = state.streetIndex.get(normalizedKey);
  if (!entry) {
    container.innerHTML = '<p>אין תוצאות עבור המפתח המבוקש.</p>';
    return;
  }
  state.defaults.streetKey = normalizedKey;
  state.streetKeyCache.set(normalizedKey, normalizedKey);
  if (elements.street.searchInput) {
    elements.street.searchInput.value = entry.display;
  }
  if (updateHash) {
    const targetHash = `#/street/${normalizedKey}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
  }

  container.innerHTML = `
    <h2>${entry.display}</h2>
    <div class="street-meta">
      <div>
        <div>מספר ערים:</div>
        <strong>${entry.cityCount}</strong>
      </div>
      <div>
        <div>משקל נדירות:</div>
        <strong>${(entry.rarityWeight || 0).toFixed(3)}</strong>
      </div>
      <div>
        <div>מפתח רחוב:</div>
        <strong>${normalizedKey}</strong>
      </div>
    </div>
  `;

  const table = document.createElement('div');
  table.className = 'street-cities';
  const rows = entry.cities
    .slice()
    .sort((a, b) => b.streetCount - a.streetCount);
  table.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>עיר</th>
          <th>שם הרחוב</th>
          <th>מספר רחובות</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(city => `
            <tr>
              <td><a href="#/city/${city.id}">${city.name}</a></td>
              <td>${city.streetDisplay || entry.display}</td>
              <td>${city.streetCount.toLocaleString()}</td>
            </tr>
          `)
          .join('')}
      </tbody>
    </table>
  `;
  container.appendChild(table);

  const mapContainer = document.createElement('div');
  mapContainer.id = 'street-map';
  container.appendChild(mapContainer);
  renderStreetMap(entry);
}


function renderStreetMap(entry) {
  const placeholder = document.getElementById('street-map');
  if (!state.cityCoords) {
    if (placeholder) {
      const fallback = document.createElement('p');
      fallback.textContent = 'למפה דרוש הקובץ city_coords.json (אופציונלי).';
      fallback.style.marginTop = '1rem';
      placeholder.replaceWith(fallback);
    }
    return;
  }

  const coords = entry.cities
    .map(city => {
      const record = state.cityCoords.get(city.id) || state.cityCoords.get(String(city.id));
      if (!record) return null;
      return {
        id: city.id,
        name: city.name,
        lat: Number(record.lat ?? record.latitude),
        lng: Number(record.lng ?? record.longitude ?? record.lon)
      };
    })
    .filter(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));

  if (!coords.length) {
    if (placeholder) {
      const fallback = document.createElement('p');
      fallback.textContent = 'אין נתוני קואורדינטות עבור הערים המופיעות ברחוב זה.';
      fallback.style.marginTop = '1rem';
      placeholder.replaceWith(fallback);
    }
    return;
  }

  if (streetMapInstance) {
    streetMapInstance.remove();
    streetMapInstance = null;
  }

  const container = document.createElement('div');
  container.id = 'street-map';
  container.style.height = '380px';
  const parent = elements.street.details;
  if (placeholder) {
    parent.replaceChild(container, placeholder);
  } else {
    parent.appendChild(container);
  }

  const centroid = coords.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 }
  );
  centroid.lat /= coords.length;
  centroid.lng /= coords.length;

  streetMapInstance = L.map(container).setView([centroid.lat, centroid.lng], coords.length > 2 ? 8 : 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(streetMapInstance);

  coords.forEach(point => {
    L.marker([point.lat, point.lng])
      .addTo(streetMapInstance)
      .bindPopup(`<strong>${point.name}</strong>`);
  });

  const bounds = L.latLngBounds(coords.map(point => [point.lat, point.lng]));
  streetMapInstance.fitBounds(bounds, { padding: [20, 20] });
}

function handleResize() {
  if (!state.ready) return;
  const { view } = parseHash();
  if (view === 'home') {
    renderHome(true);
  } else if (view === 'dedications') {
    state.rendered.cityHonors = false;
    renderCityDedicationView(true);
  } else if (view === 'graph') {
    state.rendered.graphFull = false;
    renderGraphView(true);
  }
}

function init() {
  setupCityHandlers();
  setupStreetSearch();
  setupGraphControls();
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(handleResize, 200);
  });
  onRouteChange();
  loadData();
}

init();






