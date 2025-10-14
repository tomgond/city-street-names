import * as d3 from 'd3';
import Fuse from 'fuse.js';
import L from 'leaflet';
import iconRetina from 'leaflet/dist/images/marker-icon-2x.png';
import iconDefault from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';
import 'leaflet/dist/leaflet.css';
import './styles.css';

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
  cityUniqueness: [],
  cityUniquenessRank: new Map(),
  cityUniquenessById: new Map(),
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
    layout: 'community',
    metric: 'weightedJaccard'
  },
  graphFilters: {
    focusCityId: ''
  },
  graphCommunities: {
    list: [],
    map: new Map(),
    total: 0
  },
  communityConfig: {},
  graphAvailableMetrics: ['weightedJaccard', 'jaccard'],
  graphNodeScoreCache: new Map(),
  communityStreetSignatures: new Map(),
  cityView: {
    autoDefaultUsed: false,
    primaryId: '',
    secondaryId: ''
  },
  defaults: {
    cityId: '',
    streetKey: ''
  },
  streetKeyCache: new Map(),
  streetDirectory: {
    entries: [],
    filteredEntries: [],
    totalCount: 0,
    richestStreet: null,
    query: '',
    renderedCount: 0,
    listElement: null,
    scrollArea: null,
    sentinel: null,
    statsElement: null,
    observer: null
  },
  rendered: {
    networkPreview: false,
    graphFull: false,
    cityHonors: false
  }
};

const HEBREW_COLLATOR = new Intl.Collator('he', {
  sensitivity: 'base',
  numeric: true
});

const NUMBER_FORMAT = new Intl.NumberFormat('he-IL');

const STREET_DIRECTORY_BATCH_SIZE = 150;
const GRAPH_COMMUNITY_DISPLAY_LIMIT = 8;

const KNOWN_GRAPH_METRICS = [
  'weightedJaccard',
  'jaccard',
  'inverse_df',
  'binary_cosine',
  'tfidf_cosine'
];

const METRIC_DISPLAY_LABELS = {
  weightedJaccard: 'Jaccard משוקלל',
  jaccard: 'Jaccard רגיל',
  inverse_df: 'קירבה מבוססת IDF',
  binary_cosine: 'Cosine (ערכות בינאריות)',
  tfidf_cosine: 'Cosine (TF-IDF)'
};

function normalizeMetricKey(metric) {
  if (!metric) return 'weightedJaccard';
  const key = String(metric).trim();
  if (key === 'weighted' || key === 'weighted_jaccard') return 'weightedJaccard';
  if (key === 'jaccard') return 'jaccard';
  if (key === 'inverse_df' || key === 'inverse-df') return 'inverse_df';
  if (key === 'binary_cosine' || key === 'binary-cosine' || key === 'binary') return 'binary_cosine';
  if (key === 'tfidf_cosine' || key === 'tfidf-cosine' || key === 'tfidf') return 'tfidf_cosine';
  return key;
}

function getMetricDisplayName(metricKey) {
  return METRIC_DISPLAY_LABELS[metricKey] || METRIC_DISPLAY_LABELS.weightedJaccard;
}

function deriveAvailableGraphMetrics(similarityTop, communityConfig = {}) {
  const metrics = new Set(['weightedJaccard', 'jaccard']);
  const desired = normalizeMetricKey(communityConfig.metricKey || communityConfig.weightMode);
  if (desired) metrics.add(desired);

  const sampleLists = Object.values(similarityTop || {}).slice(0, 25);
  sampleLists.forEach(list => {
    (list || []).forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      KNOWN_GRAPH_METRICS.forEach(metricKey => {
        const value = Number(entry[metricKey]);
        if (Number.isFinite(value)) {
          metrics.add(metricKey);
        }
      });
    });
  });

  return Array.from(metrics).filter(key => KNOWN_GRAPH_METRICS.includes(key));
}

const elements = {
  views: Array.from(document.querySelectorAll('[data-view]')),
  navLinks: Array.from(document.querySelectorAll('.nav-link')),
  toast: document.getElementById('global-toast'),
  home: {
    network: document.getElementById('network-preview'),
    topList: document.getElementById('top-cities-list'),
    distinctivePanel: document.getElementById('distinctive-cities-panel'),
    distinctiveList: document.getElementById('distinctive-cities-list')
  },
  graph: {
    canvas: document.getElementById('graph-view-canvas'),
    layoutSelect: document.getElementById('graph-layout-select'),
    metricSelect: document.getElementById('graph-metric-select'),
    focusInput: document.getElementById('graph-focus-city'),
    focusSuggestions: document.getElementById('graph-focus-suggestions'),
    focusClear: document.getElementById('graph-focus-clear'),
    communityLegend: document.getElementById('graph-community-legend')
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
    clearButton: document.getElementById('street-search-clear'),
    details: document.getElementById('street-details'),
    directory: document.getElementById('street-directory')
  }
};

let streetMapInstance = null;
let resizeTimer = null;

function makeEdgeKey(source, target) {
  return `${source}__${target}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
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
  const key = normalizeMetricKey(metric);
  const value = entry?.[key];
  if (typeof value === 'number') return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function updateGraphMetricOptions() {
  const metricSelect = elements.graph.metricSelect;
  if (!metricSelect) return;
  const metrics = state.graphAvailableMetrics && state.graphAvailableMetrics.length
    ? state.graphAvailableMetrics
    : ['weightedJaccard', 'jaccard'];
  const uniqueMetrics = Array.from(new Set(metrics.map(normalizeMetricKey))).filter(key =>
    KNOWN_GRAPH_METRICS.includes(key)
  );
  const current = normalizeMetricKey(state.graphSettings.metric || uniqueMetrics[0] || 'weightedJaccard');
  metricSelect.innerHTML = uniqueMetrics
    .map(key => `<option value="${key}">${getMetricDisplayName(key)}</option>`)
    .join('');
  const selected = uniqueMetrics.includes(current) ? current : uniqueMetrics[0] || 'weightedJaccard';
  state.graphSettings.metric = selected;
  metricSelect.value = selected;
}


function applyDefaultSelections() {
  state.cityView.autoDefaultUsed = false;
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
    let primaryId = '';
    if (primary && state.cityMap.has(primary)) {
      primaryId = primary;
    } else if (!state.cityView.autoDefaultUsed) {
      const fallbackId = resolveDefaultCityId();
      if (fallbackId) {
        primaryId = fallbackId;
        state.cityView.autoDefaultUsed = true;
      }
    }
    const secondaryId = secondary && state.cityMap.has(secondary) ? secondary : '';
    if (primaryId) {
      state.cityView.autoDefaultUsed = true;
      setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, primaryId);
      if (secondaryId) {
        setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, secondaryId);
      } else {
        setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
      }
      state.cityView.primaryId = primaryId;
      state.cityView.secondaryId = secondaryId;
      renderCity(primaryId, secondaryId);
      const expectedHash = secondaryId ? '#/city/' + primaryId + '/' + secondaryId : '#/city/' + primaryId;
      if (window.location.hash !== expectedHash) {
        window.location.hash = expectedHash;
      }
    } else {
      state.cityView.autoDefaultUsed = true;
      setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, '');
      setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
      state.cityView.primaryId = '';
      state.cityView.secondaryId = '';
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
        updateStreetSearchControls();
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
  if (elements.street.directory) {
    elements.street.directory.innerHTML = '<p class="street-directory-placeholder">טוען רשימת רחובות מלאה…</p>';
  }
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

    const [
      cities,
      similarityTopRaw,
      streetIndex,
      rarity,
      honorGraph,
      uniquenessRaw,
      communityConfig
    ] = await Promise.all([
      fetchJson('cities.json'),
      fetchJson('similarity_top.json'),
      fetchJson('street_index.json'),
      fetchJson('rarity_weights.json'),
      fetchJson('city_name_graph.json', { optional: true }),
      fetchJson('city_uniqueness.json', { optional: true }),
      fetchJson('community_config.json', { optional: true })
    ]);

    console.info('[data] datasets loaded', {
      cities: Array.isArray(cities) ? cities.length : 'n/a',
      similarityTop: similarityTopRaw && typeof similarityTopRaw === 'object'
        ? Object.keys(similarityTopRaw).length
        : 'n/a',
      streets: streetIndex && typeof streetIndex === 'object' ? Object.keys(streetIndex).length : 'n/a'
    });

    toggleLoading(true, 'מעבד ויזואליזציות...');

    state.cities = Array.isArray(cities) ? cities : [];
    state.cityMap = new Map(state.cities.map(city => [city.id, city]));
    state.cityNameLookup = new Map(state.cities.map(city => [city.name, city]));
    state.graphLayouts.clear();
    state.graphFilters.focusCityId = '';
    state.graphNodeScoreCache = new Map();
    updateGraphCommunityStats();
    if (elements.graph.focusInput) {
      setCityInputValue(elements.graph.focusInput, elements.graph.focusSuggestions, '');
    }
    if (elements.graph.focusClear) {
      elements.graph.focusClear.hidden = true;
    }

    const uniquenessList = Array.isArray(uniquenessRaw)
      ? uniquenessRaw
      : state.cities.map(city => ({
        id: city.id,
        name: city.name,
        streetCount: city.streetCount,
        uniqueStreetCount: city.uniqueStreetCount ?? 0,
        uniqueStreetShare: city.uniqueStreetShare ?? 0,
        meanRarityWeight: city.meanRarityWeight ?? 0,
        medianRarityWeight: city.medianRarityWeight ?? 0
      }));

    uniquenessList.sort((a, b) => {
      const shareDiff = (b.uniqueStreetShare || 0) - (a.uniqueStreetShare || 0);
      if (Math.abs(shareDiff) > 1e-9) return shareDiff;
      const countDiff = (b.uniqueStreetCount || 0) - (a.uniqueStreetCount || 0);
      if (countDiff !== 0) return countDiff;
      const meanDiff = (b.meanRarityWeight || 0) - (a.meanRarityWeight || 0);
      if (Math.abs(meanDiff) > 1e-9) return meanDiff;
      return (a.name || '').localeCompare(b.name || '');
    });

    state.cityUniqueness = uniquenessList.map((entry, index) => ({
      ...entry,
      rank: typeof entry.rank === 'number' ? entry.rank : index + 1
    }));
    state.cityUniquenessById = new Map(state.cityUniqueness.map(entry => [String(entry.id), entry]));
    state.cityUniquenessRank = new Map(state.cityUniqueness.map(entry => [String(entry.id), entry.rank]));
    state.cities.forEach(city => {
      const uniqueness = state.cityUniquenessById.get(String(city.id));
      if (!uniqueness) {
        return;
      }
      city.uniqueStreetCount = uniqueness.uniqueStreetCount ?? city.uniqueStreetCount ?? 0;
      city.uniqueStreetShare = uniqueness.uniqueStreetShare ?? city.uniqueStreetShare ?? 0;
      city.meanRarityWeight = uniqueness.meanRarityWeight ?? city.meanRarityWeight ?? 0;
      city.medianRarityWeight = uniqueness.medianRarityWeight ?? city.medianRarityWeight ?? 0;
      city.uniquenessRank = uniqueness.rank ?? city.uniquenessRank;
    });

    state.communityConfig = communityConfig || {};
    const similarityTopObject = similarityTopRaw && typeof similarityTopRaw === 'object' ? similarityTopRaw : {};
    const availableMetrics = deriveAvailableGraphMetrics(similarityTopObject, state.communityConfig);
    state.graphAvailableMetrics = availableMetrics.length ? availableMetrics : ['weightedJaccard', 'jaccard'];
    let defaultMetric = normalizeMetricKey(
      state.communityConfig.metricKey || state.communityConfig.weightMode || state.graphSettings.metric
    );
    if (!state.graphAvailableMetrics.includes(defaultMetric)) {
      defaultMetric = state.graphAvailableMetrics[0];
    }
    state.graphSettings.metric = defaultMetric;

    state.similarityTop = new Map(Object.entries(similarityTopObject));
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
    updateGraphMetricOptions();

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
    updateCommunityStreetSignatures();
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
    renderStreetDirectory();

    try {
      console.info('[data] checking for optional city coordinate data');
      const coordsResponse = await fetch(`${base}/city_coords.json`, { cache: 'no-store' });
      if (coordsResponse.ok) {
        const coords = await coordsResponse.json();
        state.cityCoords = new Map(Object.entries(coords || {}));
        console.info('[data] city coordinates loaded', { cities: state.cityCoords.size });
      } else if (coordsResponse.status !== 404) {
        console.warn('[data] city coordinate request returned', coordsResponse.status, coordsResponse.statusText);
      } else {
        console.info('[data] city coordinate data not available (map layer disabled)');
      }
    } catch (coordsError) {
      console.warn('[data] city coordinate fetch error', coordsError);
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

  const focusNodeIds = new Set([...pathNodeIds, ...cycleNodeIds]);
  let preparedNodes;
  let preparedLinks;

  if (focusNodeIds.size) {
    const allowedNodeIds = new Set(focusNodeIds);

    finalLinks.forEach(link => {
      const sourceId = String(link.source);
      const targetId = String(link.target);
      if (focusNodeIds.has(sourceId) || focusNodeIds.has(targetId)) {
        allowedNodeIds.add(sourceId);
        allowedNodeIds.add(targetId);
      }
    });

    finalNodes.forEach(node => {
      if (!node || !node.aggregated) return;
      const targetId = node.aggregateTarget ? String(node.aggregateTarget) : '';
      if (targetId && allowedNodeIds.has(targetId)) {
        allowedNodeIds.add(String(node.id));
      }
    });

    preparedNodes = finalNodes.filter(node => allowedNodeIds.has(String(node.id)));
    const allowedIds = new Set(preparedNodes.map(node => String(node.id)));
    preparedLinks = finalLinks.filter(link => {
      const sourceId = String(link.source);
      const targetId = String(link.target);
      return allowedIds.has(sourceId) && allowedIds.has(targetId);
    });
    if (!preparedNodes.length) {
      preparedNodes = finalNodes.slice();
      preparedLinks = finalLinks.slice();
    }
  } else {
    const adjacency = new Map();
    finalNodes.forEach(node => {
      const key = String(node.id);
      if (!adjacency.has(key)) {
        adjacency.set(key, new Set());
      }
    });

    finalLinks.forEach(link => {
      const sourceId = String(link.source);
      const targetId = String(link.target);
      if (!adjacency.has(sourceId)) {
        adjacency.set(sourceId, new Set());
      }
      if (!adjacency.has(targetId)) {
        adjacency.set(targetId, new Set());
      }
      adjacency.get(sourceId).add(targetId);
      adjacency.get(targetId).add(sourceId);
    });

    const visited = new Set();
    let largestComponent = new Set();

    adjacency.forEach((_, nodeId) => {
      if (visited.has(nodeId)) {
        return;
      }
      const component = new Set();
      const queue = [nodeId];
      while (queue.length) {
        const current = queue.shift();
        if (!current || visited.has(current)) {
          continue;
        }
        visited.add(current);
        component.add(current);
        const neighbors = adjacency.get(current);
        if (!neighbors) {
          continue;
        }
        neighbors.forEach(neighborId => {
          const neighborKey = String(neighborId);
          if (!neighborKey || visited.has(neighborKey) || component.has(neighborKey)) {
            return;
          }
          queue.push(neighborKey);
        });
      }
      if (component.size > largestComponent.size) {
        largestComponent = component;
      }
    });

    if (!largestComponent.size) {
      largestComponent = new Set(finalNodes.map(node => String(node.id)));
    }

    preparedNodes = finalNodes.filter(node => largestComponent.has(String(node.id)));
    const componentNodeIds = new Set(preparedNodes.map(node => String(node.id)));
    preparedLinks = finalLinks.filter(link => {
      const sourceId = String(link.source);
      const targetId = String(link.target);
      return componentNodeIds.has(sourceId) && componentNodeIds.has(targetId);
    });
  }

  const preparedGraph = {
    nodes: preparedNodes,
    links: preparedLinks,
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
  }
  console.time('[viz] renderHome');
  console.info('[viz] renderHome start');
  renderNetworkPreview(force);
  renderTopCitiesList();
  renderDistinctiveCities();
  console.info('[viz] renderHome end');
  console.timeEnd('[viz] renderHome');
}

function getTopCities(limit = 40) {
  return state.cities
    .slice()
    .sort((a, b) => b.streetCount - a.streetCount)
    .slice(0, limit);
}

const GRAPH_COMMUNITY_OTHER_KEY = '__unassigned__';

function getCommunityKey(city) {
  if (!city) return GRAPH_COMMUNITY_OTHER_KEY;
  const value = city.community;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `c${value}`;
  }
  return GRAPH_COMMUNITY_OTHER_KEY;
}

function updateGraphCommunityStats() {
  const statsMap = new Map();
  state.cities.forEach(city => {
    if (!city) return;
    const key = getCommunityKey(city);
    const communityId = typeof city.community === 'number' && Number.isFinite(city.community)
      ? city.community
      : null;
    if (!statsMap.has(key)) {
      statsMap.set(key, {
        key,
        communityId,
        size: 0,
        streetTotal: 0
      });
    }
    const entry = statsMap.get(key);
    entry.size += 1;
    entry.streetTotal += Number(city.streetCount || 0);
  });

  const list = Array.from(statsMap.values());
  list.sort((a, b) => {
    const aHasCommunity = a.communityId !== null && a.communityId !== undefined;
    const bHasCommunity = b.communityId !== null && b.communityId !== undefined;
    if (aHasCommunity && !bHasCommunity) return -1;
    if (!aHasCommunity && bHasCommunity) return 1;
    const sizeDiff = b.size - a.size;
    if (sizeDiff !== 0) return sizeDiff;
    const streetDiff = (b.streetTotal || 0) - (a.streetTotal || 0);
    if (streetDiff !== 0) return streetDiff;
    if (a.communityId !== null && b.communityId !== null) {
      return a.communityId - b.communityId;
    }
    return a.key.localeCompare(b.key);
  });

  const total = list.reduce((sum, entry) => sum + entry.size, 0);
  list.forEach(entry => {
    entry.share = total ? entry.size / total : 0;
  });

  state.graphCommunities = {
    list,
    map: new Map(list.map(entry => [entry.key, entry])),
    total
  };
}

function updateCommunityStreetSignatures() {
  const summaryMap = new Map();
  if (!state.streetIndex || state.streetIndex.size === 0) {
    state.communityStreetSignatures = summaryMap;
    return;
  }

  const totalCityCount = Array.isArray(state.cities) ? state.cities.length : 0;
  if (!totalCityCount) {
    state.communityStreetSignatures = summaryMap;
    return;
  }

  const cityCommunity = new Map();
  state.cities.forEach(city => {
    if (!city) return;
    const id = String(city.id || '');
    if (!id) return;
    const community = typeof city.community === 'number' && Number.isFinite(city.community)
      ? city.community
      : null;
    if (community === null) return;
    cityCommunity.set(id, community);
  });

  if (cityCommunity.size === 0) {
    state.communityStreetSignatures = summaryMap;
    return;
  }

  const accumulator = new Map();

  state.streetIndex.forEach((entry, streetKey) => {
    if (!entry) return;
    const cityEntries = Array.isArray(entry.cities) ? entry.cities : [];
    if (!cityEntries.length) return;

    const communityBuckets = new Map();

    for (const cityEntry of cityEntries) {
      if (!cityEntry) continue;
      const cityId = String(cityEntry.id ?? cityEntry.city ?? '');
      if (!cityId || !cityCommunity.has(cityId)) continue;
      const assigned = cityCommunity.get(cityId);
      if (!communityBuckets.has(assigned)) {
        communityBuckets.set(assigned, new Set());
      }
      communityBuckets.get(assigned).add(cityId);
    }

    const totalCommunityParticipation = communityBuckets.size;

    if (totalCommunityParticipation === 0) {
      return;
    }

    const display = typeof entry.display === 'string' && entry.display.trim()
      ? entry.display.trim()
      : streetKey;

    communityBuckets.forEach((citySet, communityId) => {
      if (!citySet || citySet.size <= 1) return;
      const normalizedCommunity = Number(communityId);
      if (!Number.isFinite(normalizedCommunity)) return;

      if (!accumulator.has(normalizedCommunity)) {
        accumulator.set(normalizedCommunity, []);
      }

      accumulator.get(normalizedCommunity).push({
        key: streetKey,
        display,
        cityCount: citySet.size,
        rarityWeight: Number(entry.rarityWeight || 0),
        globalCityCount: entry.cityCount || 0,
        communityCount: totalCommunityParticipation
      });
    });
  });

  accumulator.forEach((streets, communityId) => {
    if (!streets || streets.length === 0) return;

    const scored = streets
      .filter(street => (street?.cityCount || 0) > 1 && (street?.globalCityCount || 0) > 0)
      .map(street => {
        const tf = street.cityCount || 0;
        const docFrequency = Math.max(1, street.globalCityCount || 0);
        const ratio = totalCityCount / docFrequency;
        const idf = ratio > 1 ? Math.log(ratio) : 0;
        const baseScore = tf * idf;
        const communityCount = Number.isFinite(Number(street.communityCount))
          ? Number(street.communityCount)
          : 1;
        const otherCommunities = Math.max(0, communityCount - 1);
        const penaltyFactor = 1 / (1 + otherCommunities);
        const score = baseScore * penaltyFactor;
        return {
          ...street,
          score,
          baseScore,
          penaltyFactor,
          otherCommunities
        };
      });

    if (!scored.length) {
      return;
    }

    const sorted = scored.sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      const rarityDiff = (b.rarityWeight || 0) - (a.rarityWeight || 0);
      if (Math.abs(rarityDiff) > 1e-6) return rarityDiff;
      return HEBREW_COLLATOR.compare(a.display || '', b.display || '');
    });

    const trimmed = sorted.slice(0, 60).map(({ baseScore, penaltyFactor, otherCommunities, ...rest }) => rest);
    summaryMap.set(communityId, {
      communityId,
      total: scored.length,
      streets: trimmed
    });
  });

  state.communityStreetSignatures = summaryMap;
}

function computeGraphFocusNeighborhood(cityId, depth = 2) {
  const normalized = String(cityId || '');
  if (!normalized || !state.cityMap.has(normalized)) {
    return null;
  }
  const visited = new Set([normalized]);
  const queue = [{ id: normalized, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    if (current.depth >= depth) continue;
    const neighbors = state.similarityLookup.get(current.id);
    if (!neighbors) continue;
    neighbors.forEach((_, neighborId) => {
      const key = String(neighborId || '');
      if (!key || visited.has(key)) return;
      visited.add(key);
      queue.push({ id: key, depth: current.depth + 1 });
    });
  }

  return visited;
}

function computeGraphNodeScore(cityId) {
  const key = String(cityId || '');
  if (!key) return 0;
  if (state.graphNodeScoreCache.has(key)) {
    return state.graphNodeScoreCache.get(key);
  }

  const city = state.cityMap.get(key);
  if (!city) {
    return 0;
  }

  const baseStreetCount = Number(city.streetCount || 0);
  const neighbors = state.similarityLookup.get(key) || new Map();
  const metricKey = normalizeMetricKey(state.graphSettings?.metric || 'weightedJaccard');
  let crossCommunityCount = 0;
  let crossCommunityWeight = 0;
  let totalWeight = 0;
  let neighborCount = 0;
  const cityCommunity = typeof city.community === 'number' && Number.isFinite(city.community)
    ? city.community
    : null;

  neighbors.forEach(item => {
    if (!item) return;
    const neighborId = String(item.city || item.id || '');
    if (!neighborId) return;
    neighborCount += 1;
    const neighborCity = state.cityMap.get(neighborId);
    const neighborCommunity = typeof neighborCity?.community === 'number' && Number.isFinite(neighborCity.community)
      ? neighborCity.community
      : null;
    const weight = extractNeighborWeight(item, metricKey);
    if (!Number.isFinite(weight) || weight <= 0) {
      return;
    }
    totalWeight += weight;
    if (neighborCommunity !== cityCommunity) {
      crossCommunityCount += 1;
      crossCommunityWeight += weight;
    }
  });

  const diversity = totalWeight > 0 ? crossCommunityWeight / totalWeight : 0;
  const score =
    baseStreetCount * 1.8 +
    neighborCount * 4 +
    crossCommunityCount * 12 +
    crossCommunityWeight * 220 +
    diversity * 160;

  state.graphNodeScoreCache.set(key, score);
  return score;
}

function extractNeighborWeight(neighbor, metricKey = 'weightedJaccard') {
  if (!neighbor) return 0;
  const normalized = normalizeMetricKey(metricKey);
  const directValue = Number(neighbor?.[normalized]);
  if (Number.isFinite(directValue) && directValue > 0) {
    return directValue;
  }
  const weighted = Number(neighbor.weightedJaccard);
  if (Number.isFinite(weighted) && weighted > 0) {
    return weighted;
  }
  const jaccard = Number(neighbor.jaccard);
  if (Number.isFinite(jaccard) && jaccard > 0) {
    return jaccard;
  }
  return 0;
}

function cityHasGraphConnections(cityId) {
  const key = String(cityId || '');
  if (!key) return false;
  const metricKey = normalizeMetricKey(state.graphSettings?.metric || 'weightedJaccard');

  if (state.similarityLookup instanceof Map) {
    const neighbors = state.similarityLookup.get(key);
    if (neighbors && neighbors.size) {
      for (const neighbor of neighbors.values()) {
        if (extractNeighborWeight(neighbor, metricKey) > 0) {
          return true;
        }
      }
    }
  }

  const fallback = state.similarityTop.get(key) || [];
  for (const neighbor of fallback) {
    if (extractNeighborWeight(neighbor, metricKey) > 0) {
      return true;
    }
  }

  return false;
}

function selectGraphNodes({ limit = 50, communityLimit = GRAPH_COMMUNITY_DISPLAY_LIMIT, focusCityId = '' } = {}) {
  const safeLimit = Math.max(1, Math.floor(limit || 1));
  const focusId = focusCityId ? String(focusCityId) : '';
  const validFocusId = focusId && state.cityMap.has(focusId) ? focusId : '';
  const focusSet = validFocusId ? computeGraphFocusNeighborhood(validFocusId, 2) : null;

  const candidates = focusSet
    ? Array.from(focusSet)
      .map(id => state.cityMap.get(id))
      .filter(Boolean)
    : state.cities.slice();

  if (!candidates.length) {
    return [];
  }

  const communityMap = new Map();
  candidates.forEach(city => {
    const key = getCommunityKey(city);
    if (!cityHasGraphConnections(city?.id)) {
      return;
    }
    if (!communityMap.has(key)) {
      communityMap.set(key, {
        key,
        communityId: typeof city.community === 'number' && Number.isFinite(city.community) ? city.community : null,
        cities: []
      });
    }
    communityMap.get(key).cities.push(city);
  });

  const maxCommunities = Math.min(communityLimit, communityMap.size, safeLimit);
  const stats = state.graphCommunities || { list: [], map: new Map(), total: 0 };
  const globalOrder = Array.isArray(stats.list) ? stats.list.map(entry => entry.key) : [];
  const selectedKeys = [];
  const usedKeys = new Set();

  const tryAddKey = key => {
    if (!key || usedKeys.has(key)) return;
    if (!communityMap.has(key)) return;
    selectedKeys.push(key);
    usedKeys.add(key);
  };

  for (const key of globalOrder) {
    if (selectedKeys.length >= maxCommunities) break;
    tryAddKey(key);
  }

  if (validFocusId) {
    const focusCity = state.cityMap.get(validFocusId);
    if (focusCity) {
      const focusKey = getCommunityKey(focusCity);
      if (!usedKeys.has(focusKey)) {
        if (selectedKeys.length >= maxCommunities && selectedKeys.length > 0) {
          const removedKey = selectedKeys.pop();
          if (removedKey) {
            usedKeys.delete(removedKey);
          }
        }
        tryAddKey(focusKey);
      }
    }
  }

  if (selectedKeys.length < maxCommunities) {
    const remaining = Array.from(communityMap.values())
      .filter(entry => !usedKeys.has(entry.key))
      .sort((a, b) => b.cities.length - a.cities.length);
    for (const entry of remaining) {
      if (selectedKeys.length >= maxCommunities) break;
      tryAddKey(entry.key);
    }
  }

  if (!selectedKeys.length) {
    communityMap.forEach((_, key) => {
      if (selectedKeys.length >= maxCommunities) return;
      tryAddKey(key);
    });
  }

  const groups = selectedKeys.slice(0, maxCommunities || selectedKeys.length).map(key => {
    const entry = communityMap.get(key);
    entry.cities.sort((a, b) => {
      const scoreDiff = computeGraphNodeScore(b.id) - computeGraphNodeScore(a.id);
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
      const streetDiff = (b.streetCount || 0) - (a.streetCount || 0);
      if (streetDiff !== 0) return streetDiff;
      return HEBREW_COLLATOR.compare(a.name || '', b.name || '');
    });
    return entry;
  });

  const availableTotal = groups.reduce((sum, entry) => sum + entry.cities.length, 0);
  const actualLimit = Math.min(safeLimit, availableTotal);
  if (!actualLimit) {
    return [];
  }

  const baseDenominator = focusSet
    ? groups.reduce((sum, entry) => sum + entry.cities.length, 0)
    : groups.reduce((sum, entry) => {
      const stat = stats.map?.get(entry.key);
      return sum + (stat ? stat.size : entry.cities.length);
    }, 0) || groups.reduce((sum, entry) => sum + entry.cities.length, 0);

  const allocations = groups.map(entry => {
    const stat = stats.map?.get(entry.key);
    const weight = focusSet ? entry.cities.length : stat ? stat.size : entry.cities.length;
    const raw = baseDenominator ? (weight / baseDenominator) * actualLimit : actualLimit / groups.length;
    const capacity = entry.cities.length;
    const floored = Math.floor(raw);
    const base = Math.max(1, Math.min(capacity, floored));
    const remainder = raw - floored;
    return { entry, base, capacity, remainder, key: entry.key };
  });

  let assigned = allocations.reduce((sum, item) => sum + item.base, 0);
  let excess = assigned - actualLimit;
  if (excess > 0) {
    const reducible = allocations
      .filter(item => item.base > 1)
      .sort((a, b) => {
        const remainderDiff = a.remainder - b.remainder;
        if (Math.abs(remainderDiff) > 1e-9) return remainderDiff;
        const statA = stats.map?.get(a.key);
        const statB = stats.map?.get(b.key);
        const sizeDiff = (statA?.size || a.capacity) - (statB?.size || b.capacity);
        if (sizeDiff !== 0) return sizeDiff;
        return 0;
      });
    for (const item of reducible) {
      if (excess <= 0) break;
      const reducibleAmount = Math.min(item.base - 1, excess);
      if (reducibleAmount <= 0) continue;
      item.base -= reducibleAmount;
      excess -= reducibleAmount;
    }
    assigned = allocations.reduce((sum, item) => sum + item.base, 0);
  }

  let remaining = Math.max(0, actualLimit - assigned);
  if (remaining > 0) {
    const sortedAllocations = () =>
      allocations
        .filter(item => item.base < item.capacity)
        .sort((a, b) => {
          const spareA = a.capacity - a.base;
          const spareB = b.capacity - b.base;
          if (spareA === 0 && spareB === 0) return 0;
          if (spareA === 0) return 1;
          if (spareB === 0) return -1;
          const remainderDiff = b.remainder - a.remainder;
          if (Math.abs(remainderDiff) > 1e-9) return remainderDiff;
          const statA = stats.map?.get(a.key);
          const statB = stats.map?.get(b.key);
          const sizeDiff = (statB?.size || b.capacity) - (statA?.size || a.capacity);
          if (sizeDiff !== 0) return sizeDiff;
          return 0;
        });

    while (remaining > 0) {
      const candidates = sortedAllocations();
      if (!candidates.length) break;
      let distributed = false;
      for (const item of candidates) {
        if (item.base >= item.capacity) continue;
        item.base += 1;
        remaining -= 1;
        distributed = true;
        if (remaining === 0) break;
      }
      if (!distributed) break;
    }
  }

  const selection = [];
  allocations.forEach(item => {
    if (!item) return;
    const chosen = item.entry.cities.slice(0, item.base);
    selection.push(...chosen);
  });

  const seen = new Set();
  const result = [];
  selection.forEach(city => {
    const id = String(city.id);
    if (seen.has(id)) return;
    seen.add(id);
    result.push(city);
  });

  if (validFocusId && !seen.has(validFocusId)) {
    const focusCity = state.cityMap.get(validFocusId);
    if (focusCity && cityHasGraphConnections(focusCity.id)) {
      result.push(focusCity);
    }
  }

  if (result.length > actualLimit) {
    result.sort((a, b) => {
      const scoreDiff = computeGraphNodeScore(b.id) - computeGraphNodeScore(a.id);
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
      const streetDiff = (b.streetCount || 0) - (a.streetCount || 0);
      if (streetDiff !== 0) return streetDiff;
      return HEBREW_COLLATOR.compare(a.name || '', b.name || '');
    });
    result.length = actualLimit;
  }

  return result;
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
    maxLinks = 2000,
    height: forcedHeight = null,
    cacheKey = '',
    layout = (state.graphSettings && state.graphSettings.layout) || 'force',
    metric = (state.graphSettings && state.graphSettings.metric) || 'weightedJaccard',
    communityLimit = GRAPH_COMMUNITY_DISPLAY_LIMIT,
    focusCityId = undefined
  } = options;

  const availableMetrics = state.graphAvailableMetrics && state.graphAvailableMetrics.length
    ? state.graphAvailableMetrics
    : ['weightedJaccard', 'jaccard'];
  let metricKey = normalizeMetricKey(typeof metric === 'string' ? metric : state.graphSettings.metric);
  if (!availableMetrics.includes(metricKey)) {
    metricKey = availableMetrics[0] || 'weightedJaccard';
  }
  state.graphSettings.metric = metricKey;

  const metricDisplayName = getMetricDisplayName(metricKey);

  const focusId = focusCityId ? String(focusCityId) : state.graphFilters.focusCityId || '';

  console.info('[viz] renderNetworkGraph start', {
    limit,
    maxLinks,
    cacheKey,
    layout,
    metric: metricKey,
    communityLimit,
    focusCityId: focusId || null
  });

  const cities = selectGraphNodes({ limit, communityLimit, focusCityId: focusId });
  if (!cities.length) {
    const message = focusId
      ? 'לא נמצאו ערים במרחק של עד שתי קפיצות מהעיר שנבחרה.'
      : 'לא נמצאו ערים להצגה.';
    container.innerHTML = `<p class="empty-state">${message}</p>`;
    renderGraphCommunityLegend({ nodes: [], communityScale: null });
    return;
  }

  container.innerHTML = '';

  const allowed = new Set(cities.map(city => String(city.id)));
  const nodes = cities.map(city => ({
    id: String(city.id),
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
        jaccard: Number(neighbor.jaccard || 0),
        inverse_df: Number(neighbor.inverse_df || 0),
        binary_cosine: Number(neighbor.binary_cosine || 0),
        tfidf_cosine: Number(neighbor.tfidf_cosine || 0),
        communityWeight: Number(neighbor.communityWeight || 0)
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

  const baseLayoutKey = cacheKey || `${limit}-${maxLinks}-${communityLimit}`;
  const layoutKey = `${baseLayoutKey}|${layoutMode}|${metricKey}|${focusId || 'all'}`;
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
  const width = Math.max(rect.width || container.clientWidth || container.offsetWidth || 600, 320);
  const resolvedHeight =
    forcedHeight ?? Math.max(rect.height || container.clientHeight || container.offsetHeight || 0, 420);
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
    .attr('width', '100%')
    .attr('height', '100%')
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
    .attr('fill', '#0f172a')
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

  renderGraphCommunityLegend({ nodes, communityScale });

  console.info('[viz] renderNetworkGraph end', {
    nodes: nodes.length,
    links: trimmedLinks.length,
    communities: communityScale ? communityScale.domain().length : 0,
    cacheHit: Boolean(cachedLayout),
    metric: metricKey,
    focusCityId: focusId || null
  });
}

function renderGraphCommunityLegend({ nodes = [], communityScale } = {}) {
  const container = elements.graph.communityLegend;
  if (!container) return;

  const headerHtml = '<h3>רחובות מזהים לפי קהילה</h3>';
  const noteHtml =
    '<p class="legend-note">הרחובות ברשימה מופיעים רק בערים מתוך אותה קהילה ומייצגים חתימה ייחודית שלה.</p>';

  const communities = Array.isArray(nodes)
    ? Array.from(
        new Set(
          nodes
            .map(node =>
              typeof node.community === 'number' && Number.isFinite(node.community) ? node.community : null
            )
            .filter(value => value !== null)
        )
      ).sort((a, b) => a - b)
    : [];

  if (!communityScale || typeof communityScale !== 'function' || communities.length === 0) {
    container.innerHTML =
      headerHtml +
      noteHtml +
      '<p class="legend-community-empty">לא נמצאו קהילות עם צבעים מזוהים לגרף הנוכחי.</p>';
    container.hidden = false;
    return;
  }

  const statsMap = state.graphCommunities && state.graphCommunities.map instanceof Map
    ? state.graphCommunities.map
    : null;

  const blocks = communities
    .map(communityId => {
      const signature = state.communityStreetSignatures.get(communityId) || { streets: [], total: 0 };
      const topStreets = Array.isArray(signature.streets) ? signature.streets.slice(0, 20) : [];
      const totalUnique = typeof signature.total === 'number' ? signature.total : topStreets.length;
      const statsKey = `c${communityId}`;
      const statsEntry = statsMap ? statsMap.get(statsKey) : null;
      const totalCities = statsEntry && typeof statsEntry.size === 'number'
        ? statsEntry.size
        : nodes.filter(node => node.community === communityId).length;
      const metaParts = [];
      if (totalCities > 0) {
        metaParts.push(`${NUMBER_FORMAT.format(totalCities)} ערים`);
      }
      if (totalUnique > 0) {
        const uniqueLabel = totalUnique > 20
          ? `מתוך ${NUMBER_FORMAT.format(totalUnique)} רחובות ייחודיים`
          : `${NUMBER_FORMAT.format(totalUnique)} רחובות ייחודיים`;
        metaParts.push(uniqueLabel);
      } else {
        metaParts.push('אין רחובות ייחודיים');
      }
      const metaHtml = metaParts.length
        ? `<span class="legend-community-meta">${metaParts.join(' · ')}</span>`
        : '';

      const listHtml = topStreets.length
        ? `
            <table class="legend-street-table">
              <caption>רחובות בולטים בקהילה</caption>
              <thead>
                <tr>
                  <th scope="col">רחוב</th>
                  <th scope="col">מס' ערים בקהילה</th>
                  <th scope="col">מס' ערים בארץ</th>
                </tr>
              </thead>
              <tbody>
                ${topStreets
                  .map(street => {
                    const name = escapeHtml(street.display || street.key || '');
                    const localCount = NUMBER_FORMAT.format(Number(street.cityCount || 0));
                    const globalCount = NUMBER_FORMAT.format(Number(street.globalCityCount || 0));
                    return `<tr><th scope="row">${name}</th><td>${localCount}</td><td>${globalCount}</td></tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          `
        : '<p class="legend-community-empty">לא נמצאו רחובות ייחודיים לקהילה זו.</p>';

      const color = communityScale(communityId);
      const colorStyle = typeof color === 'string' && color.trim() ? color : '#6b7280';
      const indexLabel = NUMBER_FORMAT.format(communityId + 1);

      return `
        <section class="legend-community">
          <div class="legend-community-header">
            <span class="legend-community-title">
              <span class="legend-community-dot" style="background:${colorStyle}"></span>
              קהילה ${indexLabel}
            </span>
            ${metaHtml}
          </div>
          ${listHtml}
        </section>
      `;
    })
    .join('');

  const trimmedBlocks = blocks.trim();
  if (!trimmedBlocks) {
    container.innerHTML =
      headerHtml +
      noteHtml +
      '<p class="legend-community-empty">לא נמצאו רחובות ייחודיים לקהילות המוצגות.</p>';
    container.hidden = false;
    return;
  }

  container.innerHTML = `${headerHtml}${noteHtml}<div class="graph-community-legend-grid">${trimmedBlocks}</div>`;
  container.hidden = false;
}
function renderNetworkPreview(force = false) {
  const container = elements.home.network;
  if (!container) return;
  if (!force && state.rendered.networkPreview) return;
  renderNetworkGraph(container, {
    limit: 60,
    maxLinks: 2000,
    cacheKey: 'preview',
    layout: state.graphSettings.layout,
    metric: state.graphSettings.metric,
    communityLimit: GRAPH_COMMUNITY_DISPLAY_LIMIT,
    focusCityId: state.graphFilters.focusCityId
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
    limit: 100,
    maxLinks: 5000,
    height,
    cacheKey: 'graph-full',
    layout: state.graphSettings.layout,
    metric: state.graphSettings.metric,
    communityLimit: GRAPH_COMMUNITY_DISPLAY_LIMIT,
    focusCityId: state.graphFilters.focusCityId
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

  const createSpan = (text, className) => {
    const span = document.createElement('span');
    if (className) {
      span.className = className;
    }
    span.textContent = text;
    return span;
  };

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

    const relation = document.createElement('span');
    relation.className = 'chain-step-relation';
    relation.append(
      createSpan('בעיר', 'chain-relation-label'),
      createSpan(fromName, 'chain-relation-city from'),
      createSpan('יש רחוב בשם', 'chain-relation-label'),
      createSpan('<-', 'chain-relation-arrow'),
      createSpan(toName, 'chain-relation-city to')
    );

    cityBlock.appendChild(relation);
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
    if (streetCount > 1) {
      const countBadge = document.createElement('span');
      countBadge.className = 'chain-step-count';
      countBadge.textContent = `${streetCount} רחובות`;
      details.appendChild(countBadge);
    }

    if (details.childNodes.length) {
      step.appendChild(details);
    }
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

  let nodes = graphData.nodes.map(node => ({ ...node }));
  let links = graphData.links.map(link => ({
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

  const degreeById = new Map();
  const ensureDegree = id => {
    const key = String(id);
    if (!degreeById.has(key)) {
      degreeById.set(key, { in: 0, out: 0 });
    }
    return degreeById.get(key);
  };

  links.forEach(link => {
    const sourceId = String(link.source);
    const targetId = String(link.target);
    ensureDegree(sourceId).out += 1;
    ensureDegree(targetId).in += 1;
  });

  const keptNodeIds = new Set();
  nodes.forEach(node => {
    const id = String(node.id);
    const degree = degreeById.get(id) || { in: 0, out: 0 };
    const hasIncoming = (degree.in || 0) > 0;
    if (hasIncoming || pathNodeIds.has(id) || cycleNodeIds.has(id)) {
      keptNodeIds.add(id);
    }
  });

  nodes = nodes.filter(node => keptNodeIds.has(String(node.id)));
  links = links.filter(link => {
    const sourceId = String(link.source);
    const targetId = String(link.target);
    return keptNodeIds.has(sourceId) && keptNodeIds.has(targetId);
  });

  const removedNodes = graphData.nodes.length - nodes.length;
  const removedLinks = graphData.links.length - links.length;

  if (removedNodes > 0 || removedLinks > 0) {
    console.info('[viz] city honor graph pruning (incoming filter)', {
      originalNodes: graphData.nodes.length,
      originalLinks: graphData.links.length,
      removedNodes,
      removedLinks
    });
  }

  if (!nodes.length || !links.length) {
    container.innerHTML = '<p class="empty-state">לאחר הסרת ערים ללא רחובות נכנסים לא נותרו קשרים להצגה.</p>';
    return;
  }

  const nodeLookup = new Map(nodes.map(node => [String(node.id), node]));

  const outboundMap = new Map();
  links.forEach(link => {
    const sourceId = String(link.source);
    const targetId = String(link.target);
    if (!outboundMap.has(sourceId)) {
      outboundMap.set(sourceId, []);
    }
    outboundMap.get(sourceId).push(targetId);
  });

  const stats = graphData.stats || {};
  const layoutAnchors = new Map();
  const assignAnchor = (id, x, y, strength = 1, level = 0) => {
    const key = String(id);
    if (!key || !nodeLookup.has(key)) return;
    const existing = layoutAnchors.get(key);
    if (existing) {
      const totalStrength = Math.min(3, (existing.strength || 0) + strength);
      const weightedX =
        ((existing.x || 0) * (existing.strength || 0) + x * strength) /
        Math.max(0.001, (existing.strength || 0) + strength);
      const weightedY =
        ((existing.y || 0) * (existing.strength || 0) + y * strength) /
        Math.max(0.001, (existing.strength || 0) + strength);
      const nextLevel =
        existing.level === undefined || existing.level === null
          ? level
          : level === undefined || level === null
            ? existing.level
            : Math.min(existing.level, level);
      layoutAnchors.set(key, {
        x: weightedX,
        y: weightedY,
        strength: totalStrength,
        level: nextLevel ?? existing.level ?? 0
      });
    } else {
      layoutAnchors.set(key, { x, y, strength, level });
    }
  };

  const computeUniqueSequence = cities => {
    if (!Array.isArray(cities) || !cities.length) return [];
    const seen = new Set();
    const unique = [];
    cities.forEach(entry => {
      const key = String(entry);
      if (!key || seen.has(key)) return;
      seen.add(key);
      unique.push(key);
    });
    return unique;
  };

  const longestPathCities = computeUniqueSequence(stats.longestPath?.cities);
  if (longestPathCities.length) {
    const marginX = Math.min(140, width * 0.14);
    const span = Math.max(width - marginX * 2, 320);
    const step = longestPathCities.length > 1 ? span / (longestPathCities.length - 1) : 0;
    longestPathCities.forEach((cityId, index) => {
      const x = marginX + step * index;
      const y = Math.max(80, height * 0.28);
      assignAnchor(cityId, x, y, 1.8, 0);
    });
  }

  const longestCycleCities = computeUniqueSequence(stats.longestCycle?.cities);
  if (longestCycleCities.length) {
    const centerX = width / 2;
    const centerY = Math.min(height * 0.7, height - 160);
    const baseRadius = Math.min(width, height) * 0.24 + longestCycleCities.length * 4;
    longestCycleCities.forEach((cityId, index) => {
      const angle = (index / longestCycleCities.length) * Math.PI * 2;
      const x = centerX + Math.cos(angle) * baseRadius;
      const y = centerY + Math.sin(angle) * baseRadius * 0.55;
      assignAnchor(cityId, x, y, 1.4, 1);
    });
  }

  const propagationQueue = Array.from(layoutAnchors.entries()).map(([id, anchor]) => ({
    id,
    level: anchor.level ?? 0
  }));
  const seenAnchors = new Set(layoutAnchors.keys());
  while (propagationQueue.length) {
    const current = propagationQueue.shift();
    const baseAnchor = layoutAnchors.get(current.id);
    if (!baseAnchor) continue;
    const neighbors = outboundMap.get(current.id) || [];
    if (!neighbors.length) continue;
    const spread = Math.max(90, 180 - neighbors.length * 18);
    neighbors.forEach((neighborId, neighborIndex) => {
      const key = String(neighborId);
      if (!key || !nodeLookup.has(key) || seenAnchors.has(key)) return;
      const offsetIndex = neighborIndex - (neighbors.length - 1) / 2;
      const targetX = baseAnchor.x + offsetIndex * spread;
      const baseLevel = baseAnchor.level ?? current.level ?? 0;
      const targetY = Math.min(height - 80, baseAnchor.y + 130);
      assignAnchor(key, targetX, targetY, 0.9, baseLevel + 1);
      seenAnchors.add(key);
      propagationQueue.push({ id: key, level: baseLevel + 1 });
    });
  }

  const unanchoredNodes = nodes.filter(node => !layoutAnchors.has(String(node.id)));
  if (unanchoredNodes.length) {
    const centerX = width / 2;
    const baseRadius = Math.min(width, height) * 0.32;
    const startAngle = Math.PI / 8;
    unanchoredNodes.forEach((node, index) => {
      const angle = startAngle + (index / Math.max(1, unanchoredNodes.length)) * Math.PI * 1.6;
      const x = centerX + Math.cos(angle) * baseRadius;
      const y = height * 0.42 + Math.sin(angle) * baseRadius * 0.45;
      assignAnchor(node.id, x, y, 0.7, 1);
    });
  }

  const aggregatedGroups = new Map();
  nodes.forEach(node => {
    if (!node || !node.aggregated) return;
    const targetId = String(node.aggregateTarget ?? '');
    if (!aggregatedGroups.has(targetId)) {
      aggregatedGroups.set(targetId, []);
    }
    aggregatedGroups.get(targetId).push(String(node.id));
  });

  aggregatedGroups.forEach((groupIds, targetId) => {
    const anchor = layoutAnchors.get(targetId) || { x: width / 2, y: Math.min(height * 0.65, height - 140), level: 1 };
    const radius = 70 + groupIds.length * 6;
    groupIds.forEach((nodeId, index) => {
      const angle = (index / groupIds.length) * Math.PI * 1.2 - Math.PI * 0.6;
      const x = anchor.x + Math.cos(angle) * radius;
      const y = Math.min(height - 60, anchor.y + Math.sin(angle) * radius * 0.7);
      assignAnchor(nodeId, x, y, 0.6, (anchor.level ?? 1) + 1);
    });
  });

  nodes.forEach(node => {
    const anchor = layoutAnchors.get(String(node.id));
    if (anchor) {
      node.x = anchor.x + (Math.random() - 0.5) * 18;
      node.y = anchor.y + (Math.random() - 0.5) * 18;
      node._layoutAnchor = anchor;
    } else {
      node.x = width / 2 + (Math.random() - 0.5) * 220;
      node.y = height / 2 + (Math.random() - 0.5) * 220;
      node._layoutAnchor = { x: width / 2, y: height / 2, strength: 0.06, level: 1 };
    }
  });

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
    });

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

  const resolveNode = nodeRef => {
    if (nodeRef && typeof nodeRef === 'object') {
      return nodeRef;
    }
    return nodeLookup.get(String(nodeRef)) || null;
  };

  const computeLinkEndpoints = link => {
    const sourceNode = resolveNode(link.source);
    const targetNode = resolveNode(link.target);
    if (!sourceNode || !targetNode) {
      return {
        x1: sourceNode?.x ?? 0,
        y1: sourceNode?.y ?? 0,
        x2: targetNode?.x ?? 0,
        y2: targetNode?.y ?? 0
      };
    }

    const dx = targetNode.x - sourceNode.x;
    const dy = targetNode.y - sourceNode.y;
    const distance = Math.hypot(dx, dy) || 1;
    const sourceRadius = getHonorNodeRadius(sourceNode) + 2;
    const targetRadius = getHonorNodeRadius(targetNode) + 6;
    const startRatio = sourceRadius / distance;
    const endRatio = targetRadius / distance;

    return {
      x1: sourceNode.x + dx * startRatio,
      y1: sourceNode.y + dy * startRatio,
      x2: targetNode.x - dx * endRatio,
      y2: targetNode.y - dy * endRatio
    };
  };

  const updatePositions = () => {
    nodes.forEach(node => clampNodeToBounds(node, width, height, 40));
    linkSelection.each(function (d) {
      const { x1, y1, x2, y2 } = computeLinkEndpoints(d);
      d3.select(this)
        .attr('x1', x1)
        .attr('y1', y1)
        .attr('x2', x2)
        .attr('y2', y2);
    });
    nodeSelection.attr('transform', d => `translate(${d.x}, ${d.y})`);
  };

  const manualDrag = d3
    .drag()
    .on('start', event => {
      const node = clampNodeToBounds(event.subject, width, height, 40);
      node.fx = node.x;
      node.fy = node.y;
      node.vx = 0;
      node.vy = 0;
    })
    .on('drag', event => {
      event.subject.x = event.x;
      event.subject.y = event.y;
      const node = clampNodeToBounds(event.subject, width, height, 40);
      node.fx = node.x;
      node.fy = node.y;
      node.vx = 0;
      node.vy = 0;
      if (node._layoutAnchor) {
        node._layoutAnchor.x = node.x;
        node._layoutAnchor.y = node.y;
      }
      updatePositions();
    })
    .on('end', event => {
      const node = clampNodeToBounds(event.subject, width, height, 40);
      node.fx = node.x;
      node.fy = node.y;
      node.vx = 0;
      node.vy = 0;
      if (node._layoutAnchor) {
        node._layoutAnchor.x = node.x;
        node._layoutAnchor.y = node.y;
      }
      updatePositions();
    });

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      'link',
      d3
        .forceLink(links)
        .id(d => d.id)
        .distance(d => {
          const count = Number(d.streetCount || (Array.isArray(d.streets) ? d.streets.length : 1) || 1);
          const scaled = Math.max(0, Math.min(count, 12));
          return 190 - scaled * 8;
        })
        .strength(0.55)
    )
    .force(
      'x',
      d3
        .forceX(d => (d._layoutAnchor ? d._layoutAnchor.x : width / 2))
        .strength(d => Math.max(0.04, Math.min(d._layoutAnchor?.strength ?? 0.08, 2.5)))
    )
    .force(
      'y',
      d3
        .forceY(d => (d._layoutAnchor ? d._layoutAnchor.y : height / 2))
        .strength(d => Math.max(0.04, Math.min(d._layoutAnchor?.strength ?? 0.08, 2.5)))
    )
    .force('charge', d3.forceManyBody().strength(-320))
    .force('collision', d3.forceCollide().radius(d => getHonorNodeRadius(d) + 12).iterations(2));

  simulation.on('tick', updatePositions);
  simulation.on('end', () => {
    updatePositions();
    nodes.forEach(node => {
      node.fx = node.x;
      node.fy = node.y;
      node.vx = 0;
      node.vy = 0;
    });
    nodeSelection.call(manualDrag);
    nodeSelection.style('cursor', 'grab');
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


function renderTopCitiesList() {
  if (!elements.home.topList) return;
  const topCities = getTopCities(12);
  elements.home.topList.innerHTML = topCities
    .map(city => `
      <li>
        <a href="#/city/${city.id}" class="top-city-link">
          <strong>${city.name}</strong>
          <span class="count">${city.streetCount.toLocaleString()} רחובות</span>
        </a>
      </li>
    `)
    .join('');
}

function formatPercentage(value, digits = 1) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '0%';
  }
  const percentage = value * 100;
  const safeDigits = Math.max(0, Math.min(3, digits));
  return `${percentage.toFixed(safeDigits)}%`;
}

function formatRarityWeight(value, digits = 1) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '0%';
  }
  const safeDigits = Math.max(0, Math.min(2, digits));
  return `${value.toFixed(safeDigits)}%`;
}

function renderDistinctiveCities(limit = 8) {
  const panel = elements.home.distinctivePanel;
  const list = elements.home.distinctiveList;
  if (!panel || !list) return;

  const eligibleEntries = state.cityUniqueness.filter(entry => {
    if (!entry) return false;
    let streetTotal =
      entry.streetCount ?? entry.totalStreetCount ?? entry.totalStreets ?? entry.cityStreetCount ?? null;
    if (streetTotal === null || streetTotal === undefined) {
      if (Array.isArray(entry.streets)) {
        streetTotal = entry.streets.length;
      } else if (typeof entry.streets === 'number') {
        streetTotal = entry.streets;
      }
    }
    const numericTotal = Number(streetTotal);
    return Number.isFinite(numericTotal) && numericTotal > 30;
  });

  const entries = eligibleEntries.slice(0, limit);
  if (!entries.length) {
    panel.hidden = true;
    list.innerHTML = '';
    return;
  }

  panel.hidden = false;
  list.innerHTML = entries
    .map(entry => {
      const uniqueCount = entry.uniqueStreetCount ?? 0;
      const share = formatPercentage(entry.uniqueStreetShare ?? 0, 1);
      const median = typeof entry.medianRarityWeight === 'number' ? entry.medianRarityWeight : 0;
      const mean = typeof entry.meanRarityWeight === 'number' ? entry.meanRarityWeight : 0;
      const rank = entry.rank ?? 0;
      return `
        <li>
          <a href="#/city/${entry.id}" class="top-city-link distinctive">
            <div class="row-main">
              <span class="rank">#${rank}</span>
              <strong>${entry.name}</strong>
            </div>
            <div class="row-sub">
              <span>${uniqueCount.toLocaleString()} רחובות ייחודיים (${share})</span>
              <span>ממוצע נדירות: ${formatRarityWeight(mean, 1)}, חציון: ${formatRarityWeight(median, 1)}</span>
            </div>
          </a>
        </li>
      `;
    })
    .join('');
}

function getUniqueStreetExamples(cityId, limit = 6) {
  if (!cityId || !state.cityMap.has(cityId)) {
    return [];
  }
  const city = state.cityMap.get(cityId);
  const streets = Array.isArray(city?.streets) ? city.streets : [];
  if (!streets.length) {
    return [];
  }

  const examples = [];
  streets.forEach(street => {
    if (!street || !street.key) return;
    const entry = state.streetIndex.get(street.key);
    if (!entry) return;
    const { cityCount, cities = [] } = entry;
    if (Number(cityCount || cities.length) > 1) {
      const onlyCurrentCity = Array.isArray(cities)
        ? cities.every(item => String(item?.id) === String(cityId))
        : false;
      if (!onlyCurrentCity) {
        return;
      }
    }
    const rarity = typeof street.rarityWeight === 'number' && Number.isFinite(street.rarityWeight)
      ? street.rarityWeight
      : typeof entry.rarityWeight === 'number' && Number.isFinite(entry.rarityWeight)
        ? entry.rarityWeight
        : Number(state.rarityWeights?.[street.key] || 0);
    examples.push({
      key: street.key,
      display: street.display || entry.display || street.normDisplay || street.key,
      rarity: Number.isFinite(rarity) ? rarity : 0
    });
  });

  examples.sort((a, b) => {
    const rarityDiff = (b.rarity || 0) - (a.rarity || 0);
    if (Math.abs(rarityDiff) > 1e-9) return rarityDiff;
    return (a.display || '').localeCompare(b.display || '');
  });

  return examples.slice(0, Math.max(0, limit));
}

function renderCity(primaryId, secondaryId = '') {
  const normalizedPrimaryId = primaryId ? String(primaryId) : '';
  const normalizedSecondaryId = secondaryId ? String(secondaryId) : '';

  if (!normalizedPrimaryId || !state.cityMap.has(normalizedPrimaryId)) {
    state.cityView.primaryId = '';
    state.cityView.secondaryId = '';
    state.cityView.autoDefaultUsed = true;
    setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, '');
    setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
    elements.city.summary.innerHTML = '<p>בחרו עיר כדי לראות את הנתונים.</p>';
    elements.city.chart.innerHTML = '';
    elements.city.similarList.innerHTML = '';
    elements.city.sharedList.innerHTML = '';
    elements.city.overlap.innerHTML = '';
    return;
  }

  const city = state.cityMap.get(normalizedPrimaryId);
  if (!city) {
    state.cityView.primaryId = '';
    state.cityView.secondaryId = '';
    state.cityView.autoDefaultUsed = true;
    setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, '');
    setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
    elements.city.summary.innerHTML = '<p>בחרו עיר כדי לראות את הנתונים.</p>';
    elements.city.chart.innerHTML = '';
    elements.city.similarList.innerHTML = '';
    elements.city.sharedList.innerHTML = '';
    elements.city.overlap.innerHTML = '';
    return;
  }

  state.cityView.primaryId = normalizedPrimaryId;
  state.cityView.secondaryId = state.cityMap.has(normalizedSecondaryId) ? normalizedSecondaryId : '';

  state.cityView.autoDefaultUsed = true;
  setCityInputValue(elements.city.primarySelect, elements.city.primarySuggestions, normalizedPrimaryId);

  const similarity = state.similarityTop.get(normalizedPrimaryId) || [];
  const uniqueCount = city.uniqueStreetCount ?? 0;
  const uniqueShare = typeof city.uniqueStreetShare === 'number' ? city.uniqueStreetShare : city.streetCount ? uniqueCount / city.streetCount : 0;
  const meanRarity = typeof city.meanRarityWeight === 'number' ? city.meanRarityWeight : 0;
  const medianRarity = typeof city.medianRarityWeight === 'number' ? city.medianRarityWeight : 0;
  const uniquenessRank = state.cityUniquenessRank.get(String(normalizedPrimaryId)) ?? city.uniquenessRank ?? null;
  const rankLabel = uniquenessRank ? `#${uniquenessRank}` : '—';
  const uniqueExamples = getUniqueStreetExamples(normalizedPrimaryId, 6);
  const uniqueSection = uniqueExamples.length
    ? `
      <div class="city-unique-examples">
        <h3>דוגמאות לרחובות ייחודיים</h3>
        <ul class="unique-street-list">
          ${uniqueExamples
      .map(
        street => `
                <li>
                  <span class="unique-street-name">${street.display}</span>
                  <span class="unique-street-rarity">משקל נדירות: ${formatRarityWeight(street.rarity, 1)}</span>
                </li>
              `
      )
      .join('')}
        </ul>
      </div>
    `
    : `
      <div class="city-unique-examples empty">
        <h3>דוגמאות לרחובות ייחודיים</h3>
        <p>לא נמצאו רחובות ייחודיים להצגה.</p>
      </div>
    `;
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
      <div>
        <div>רחובות ייחודיים:</div>
        <strong>${uniqueCount.toLocaleString()} (${formatPercentage(uniqueShare, 1)})</strong>
      </div>
      <div>
        <div>מדד נדירות (ממוצע/חציון):</div>
        <strong>${formatRarityWeight(meanRarity, 1)} / ${formatRarityWeight(medianRarity, 1)}</strong>
      </div>
      <div>
        <div>דירוג ייחודיות ארצי:</div>
        <strong>${rankLabel}</strong>
      </div>
    </div>
    ${uniqueSection}
  `;

  renderCityChart(city, similarity);
  const selectedPartnerId = state.cityView.secondaryId || '';
  renderCitySimilarButtons(normalizedPrimaryId, similarity, selectedPartnerId);
  if (selectedPartnerId) {
    setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, selectedPartnerId);
  } else {
    setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, '');
  }
  renderSharedStreets(normalizedPrimaryId, selectedPartnerId || null);
  renderOverlap(normalizedPrimaryId, selectedPartnerId || '');
}

function renderCityChart(city, similarity) {
  const container = elements.city.chart;
  if (!container) return;
  container.innerHTML = '';
  container.style.minHeight = '';
  if (!similarity.length) {
    container.innerHTML = '<p>לא נמצאו ערים עם דמיון משמעותי.</p>';
    return;
  }

  const data = similarity.slice(0, 10);
  const labelAccessor = item => state.cityMap.get(item.city)?.name || item.city;
  const bounds = container.getBoundingClientRect();
  const containerWidth = Math.max(bounds.width || container.clientWidth || 0, 320);
  const longestLabelLength = data.reduce((max, item) => {
    const label = labelAccessor(item) || '';
    return Math.max(max, label.length);
  }, 0);

  const margin = {
    top: 18,
    right: 28,
    bottom: 36,
    left: Math.min(280, Math.max(140, longestLabelLength * 13))
  };

  const barHeight = 38;
  const chartHeight = Math.max(
    220,
    margin.top + margin.bottom + data.length * barHeight
  );
  const chartWidth = Math.max(containerWidth, margin.left + 160);
  const tickCount = Math.max(3, Math.min(6, Math.round(chartWidth / 160)));

  container.style.minHeight = `${chartHeight}px`;

  const rootStyles = getComputedStyle(document.documentElement);
  const textColor = (rootStyles.getPropertyValue('--text') || '').trim() || '#2e2216';
  const labelStroke = 'rgba(255, 255, 255, 0.9)';

  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `0 0 ${chartWidth} ${chartHeight}`)
    .attr('preserveAspectRatio', 'xMidYMid meet')
    .attr('width', chartWidth)
    .attr('height', chartHeight)
    .style('width', '100%')
    .style('height', `${chartHeight}px`)
    .style('max-width', '100%')
    .style('display', 'block')
    .style('overflow', 'visible')
    .classed('city-similarity-chart', true);

  const maxValue = d3.max(data, d => d.weightedJaccard) || 0.1;
  const x = d3
    .scaleLinear()
    .domain([0, maxValue])
    .nice()
    .range([margin.left, chartWidth - margin.right]);

  const y = d3
    .scaleBand()
    .domain(data.map(item => item.city))
    .range([margin.top, chartHeight - margin.bottom])
    .padding(Math.min(0.32, Math.max(0.18, 1 - data.length * 0.05)));

  const color = d3.scaleSequential(d3.interpolatePlasma).domain([0, Math.max(1, data.length - 1)]);

  const grid = svg
    .append('g')
    .attr('class', 'chart-grid')
    .attr('transform', `translate(0, ${chartHeight - margin.bottom})`)
    .call(
      d3
        .axisBottom(x)
        .ticks(tickCount)
        .tickSize(-(chartHeight - margin.top - margin.bottom))
        .tickFormat('')
    );

  grid
    .selectAll('line')
    .attr('stroke', 'rgba(135, 104, 73, 0.18)')
    .attr('stroke-dasharray', '3 4');

  grid.select('.domain').remove();

  const bars = svg
    .append('g')
    .selectAll('rect')
    .data(data)
    .enter()
    .append('rect')
    .attr('x', margin.left)
    .attr('y', d => y(d.city))
    .attr('height', y.bandwidth())
    .attr('width', d => Math.max(0, x(d.weightedJaccard) - margin.left))
    .attr('fill', (_, i) => color(i))
    .attr('rx', 10)
    .style('cursor', 'pointer')
    .on('click', (_, d) => {
      renderSharedStreets(city.id, d.city);
      setCityInputValue(elements.city.secondarySelect, elements.city.secondarySuggestions, d.city);
      window.location.hash = `#/city/${city.id}/${d.city}`;
    });

  bars.append('title').text(d => {
    const label = labelAccessor(d);
    return `${label}\nמדד דמיון משוקלל: ${d.weightedJaccard.toFixed(3)}`;
  });

  const yAxis = svg
    .append('g')
    .attr('transform', `translate(${margin.left}, 0)`)
    .call(
      d3
        .axisLeft(y)
        .tickFormat('')
        .tickSize(0)
    );

  yAxis
    .select('.domain')
    .attr('stroke', 'rgba(135, 104, 73, 0.4)')
    .attr('stroke-width', 1.2);

  const labelPadding = 10;
  const labelGroup = svg
    .append('g')
    .attr('class', 'city-chart-y-labels')
    .attr('pointer-events', 'none');

  const labelNodes = labelGroup
    .selectAll('g')
    .data(data)
    .enter()
    .append('g')
    .attr('class', 'city-chart-y-label')
    .attr('transform', d => `translate(0, ${y(d.city) + y.bandwidth() / 2})`);

  labelNodes
    .append('text')
    .attr('class', 'city-chart-y-label-text')
    .attr('alignment-baseline', 'middle')
    .attr('direction', 'rtl')
    .attr('fill', textColor)
    .style('font-weight', '600')
    .style('font-size', '0.95rem')
    .style('stroke', labelStroke)
    .style('stroke-width', '3px')
    .style('paint-order', 'stroke fill')
    .text(labelAccessor);

  labelNodes
    .insert('rect', 'text')
    .attr('class', 'city-chart-y-label-bg')
    .attr('fill', 'rgba(255, 255, 255, 0.92)')
    .attr('stroke', 'rgba(135, 104, 73, 0.25)')
    .attr('stroke-width', 1);

  labelNodes.each(function (d) {
    const group = d3.select(this);
    const textNode = group.select('text').node();
    const rect = group.select('rect');
    if (!textNode || !rect.node()) return;
    const bbox = textNode.getBBox();
    const rectWidth = bbox.width + labelPadding * 1.8;
    const rectHeight = bbox.height + 4;
    const xPosition = margin.left - 12 - rectWidth;

    group.attr('transform', `translate(${xPosition}, ${y(d.city) + y.bandwidth() / 2})`);

    rect
      .attr('x', 0)
      .attr('y', -rectHeight / 2)
      .attr('width', rectWidth)
      .attr('height', rectHeight)
      .attr('rx', 6)
      .attr('ry', 6);

    group
      .select('text')
      .attr('x', rectWidth - labelPadding * 0.9)
      .attr('text-anchor', 'start');
  });

  const xAxis = svg
    .append('g')
    .attr('transform', `translate(0, ${chartHeight - margin.bottom})`)
    .call(
      d3
        .axisBottom(x)
        .ticks(tickCount)
        .tickFormat(value => value.toFixed(2))
        .tickSizeOuter(0)
    );

  xAxis
    .selectAll('text')
    .style('fill', textColor)
    .style('font-size', '0.85rem')
    .attr('dy', '1.2em')
    .style('paint-order', 'stroke fill')
    .style('stroke', labelStroke)
    .style('stroke-width', '4px');

  xAxis.select('.domain').remove();

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
      state.cityView.primaryId = primaryId;
      state.cityView.secondaryId = item.city;
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
    const rarityText = formatRarityWeight(rarity, 1);
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

  const primary = state.cityMap.get(primaryId);
  if (!primary) {
    container.innerHTML = '<p>לא ניתן לטעון את הנתונים עבור העיר שנבחרה.</p>';
    return;
  }

  if (!secondaryId) {
    const streets = Array.isArray(primary.streets) ? primary.streets : [];
    if (!streets.length) {
      container.innerHTML = '<p>לא נמצאו רחובות להצגה עבור העיר שנבחרה.</p>';
      return;
    }

    const sorted = streets
      .map(street => {
        const rarityValue =
          typeof street?.rarityWeight === 'number' && Number.isFinite(street.rarityWeight)
            ? street.rarityWeight
            : Number(state.rarityWeights?.[street.key]) || 0;
        return {
          ...street,
          rarity: rarityValue
        };
      })
      .sort((a, b) => {
        const rarityDiff = (b.rarity || 0) - (a.rarity || 0);
        if (Math.abs(rarityDiff) > 1e-9) return rarityDiff;
        const aLabel = a.display || a.normDisplay || a.name || a.key || '';
        const bLabel = b.display || b.normDisplay || b.name || b.key || '';
        return aLabel.localeCompare(bLabel);
      });

    const note = document.createElement('p');
    note.className = 'overlap-note';
    note.textContent = `כל הרחובות בעיר ${primary.name}`;
    container.appendChild(note);

    const list = document.createElement('ul');
    sorted.forEach(street => {
      const li = document.createElement('li');
      const displayName = street.display || street.normDisplay || street.name || street.key;
      li.innerHTML = `
        <span>${displayName}</span>
        <div class="overlap-actions">
          <small>משקל נדירות: ${formatRarityWeight(street.rarity, 1)}</small>
          <button type="button">לפרטי רחוב</button>
        </div>
      `;
      li.querySelector('button').addEventListener('click', () => navigateToStreet(street.key));
      list.appendChild(li);
    });
    container.appendChild(list);
    return;
  }

  const secondary = state.cityMap.get(secondaryId);
  if (!secondary) {
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
        <small>משקל נדירות: ${formatRarityWeight(street.rarity, 1)}</small>
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
        state.cityView.autoDefaultUsed = true;
        const companionId = getSelectedCityId(secondaryInput);
        const hasCompanion = companionId && state.cityMap.has(companionId);
        const partnerId = hasCompanion ? companionId : '';
        state.cityView.primaryId = city.id;
        state.cityView.secondaryId = partnerId;
        renderCity(city.id, partnerId);
        const targetHash = partnerId ? `#/city/${city.id}/${partnerId}` : `#/city/${city.id}`;
        if (window.location.hash !== targetHash) {
          window.location.hash = targetHash;
        }
      },
      onClear: () => {
        state.cityView.autoDefaultUsed = true;
        state.cityView.primaryId = '';
        state.cityView.secondaryId = '';
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
        state.cityView.autoDefaultUsed = true;
        const primaryId = getSelectedCityId(primaryInput);
        if (!primaryId) {
          setCityInputValue(primaryInput, primarySuggestions, city.id);
          state.cityView.primaryId = city.id;
          state.cityView.secondaryId = '';
          renderCity(city.id, '');
          if (window.location.hash !== `#/city/${city.id}`) {
            window.location.hash = `#/city/${city.id}`;
          }
          return;
        }
        state.cityView.primaryId = primaryId;
        state.cityView.secondaryId = city.id;
        renderSharedStreets(primaryId, city.id);
        renderOverlap(primaryId, city.id);
        const targetHash = `#/city/${primaryId}/${city.id}`;
        if (window.location.hash !== targetHash) {
          window.location.hash = targetHash;
        }
      },
      onClear: () => {
        state.cityView.autoDefaultUsed = true;
        const primaryId = getSelectedCityId(primaryInput);
        if (!primaryId) return;
        state.cityView.secondaryId = '';
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
  const input = elements.street.searchInput;
  if (!input) return;

  const searchButton = elements.street.searchButton;
  const clearButton = elements.street.clearButton;
  let debounceTimer = null;

  const triggerFilter = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    applyStreetFilter(input.value || '');
  };

  if (searchButton) {
    searchButton.addEventListener('click', () => {
      triggerFilter();
      input.focus({ preventScroll: true });
    });
  }

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      triggerFilter();
    }
  });

  input.addEventListener('input', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      applyStreetFilter(input.value || '');
    }, 180);
  });

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      if (!input.value) {
        applyStreetFilter('');
        input.focus({ preventScroll: true });
        return;
      }
      input.value = '';
      applyStreetFilter('');
      input.focus({ preventScroll: true });
    });
    clearButton.disabled = true;
  }

  updateStreetSearchControls();
}

function setupStreetDirectory() {
  const container = elements.street.directory;
  if (!container) return;
  container.addEventListener('click', event => {
    const button = event.target.closest('[data-street-key]');
    if (!button) return;
    event.preventDefault();
    const key = button.getAttribute('data-street-key');
    if (!key) return;
    navigateToStreet(key);
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
      const newMetric = normalizeMetricKey((event.target && event.target.value) || 'weightedJaccard');
      if (!state.graphAvailableMetrics.includes(newMetric)) {
        console.warn('[viz] unsupported metric requested; ignoring', { metric: newMetric });
        metricSelect.value = state.graphSettings.metric;
        return;
      }
      if (state.graphSettings.metric === newMetric) return;
      state.graphSettings.metric = newMetric;
      metricSelect.value = newMetric;
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

  const focusInput = elements.graph.focusInput;
  const focusSuggestions = elements.graph.focusSuggestions;
  const focusClear = elements.graph.focusClear;

  if (focusClear) {
    focusClear.hidden = !state.graphFilters.focusCityId;
  }

  const refreshGraphs = () => {
    state.graphLayouts.clear();
    state.rendered.graphFull = false;
    state.rendered.networkPreview = false;
    if (!state.ready) return;
    renderNetworkPreview(true);
    if (parseHash().view === 'graph') {
      renderGraphView(true);
    }
  };

  if (focusInput && focusSuggestions) {
    wireCityAutocomplete(focusInput, focusSuggestions, {
      onSelect: city => {
        if (!city) return;
        state.graphFilters.focusCityId = String(city.id);
        if (focusClear) {
          focusClear.hidden = false;
        }
        refreshGraphs();
      },
      onClear: () => {
        if (!state.graphFilters.focusCityId) return;
        state.graphFilters.focusCityId = '';
        if (focusClear) {
          focusClear.hidden = true;
        }
        refreshGraphs();
      }
    });
  }

  if (focusClear) {
    focusClear.addEventListener('click', () => {
      if (!state.graphFilters.focusCityId) return;
      state.graphFilters.focusCityId = '';
      if (focusInput) {
        setCityInputValue(focusInput, focusSuggestions, '');
      }
      focusClear.hidden = true;
      refreshGraphs();
    });
  }

  updateGraphMetricOptions();
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


function renderStreetDirectory() {
  const container = elements.street.directory;
  if (!container) return;

  if (!state.streetIndex || state.streetIndex.size === 0) {
    container.innerHTML = '<p class="street-directory-placeholder">אין נתונים להצגה.</p>';
    state.streetDirectory.entries = [];
    state.streetDirectory.filteredEntries = [];
    state.streetDirectory.totalCount = 0;
    state.streetDirectory.richestStreet = null;
    state.streetDirectory.listElement = null;
    state.streetDirectory.scrollArea = null;
    state.streetDirectory.sentinel = null;
    state.streetDirectory.statsElement = null;
    state.streetDirectory.renderedCount = 0;
    if (state.streetDirectory.observer) {
      state.streetDirectory.observer.disconnect();
      state.streetDirectory.observer = null;
    }
    updateStreetDirectoryStats();
    updateStreetSearchControls();
    return;
  }

  const entries = Array.from(state.streetIndex.entries()).map(([key, value]) => {
    const displayName = typeof value?.display === 'string' ? value.display.trim() : '';
    const normalizedName = typeof value?.normDisplay === 'string' ? value.normDisplay.trim() : '';
    const display = displayName || normalizedName || key;
    const cityCount = Number(value?.cityCount || 0);
    return { key, display, cityCount };
  });

  entries.sort((a, b) => {
    const countDiff = b.cityCount - a.cityCount;
    if (countDiff !== 0) return countDiff;
    return HEBREW_COLLATOR.compare(a.display, b.display);
  });

  const previousQuery =
    state.streetDirectory.query || (elements.street.searchInput ? elements.street.searchInput.value : '');

  state.streetDirectory.entries = entries;
  state.streetDirectory.filteredEntries = entries;
  state.streetDirectory.totalCount = entries.length;
  state.streetDirectory.richestStreet = entries[0] || null;
  state.streetDirectory.renderedCount = 0;

  container.innerHTML = `
    <header class="street-directory-header">
      <div>
        <h2>רשימת כל הרחובות</h2>
        <p class="street-directory-stats" data-street-directory-stats></p>
      </div>
      <button type="button" class="street-directory-scroll-top" aria-label="חזרה לראש הרשימה">חזרה לראש</button>
    </header>
    <div class="street-directory-scroll" tabindex="0">
      <ul class="street-directory-list" aria-label="כל הרחובות המנורמלים בישראל"></ul>
      <div class="street-directory-sentinel" aria-hidden="true"></div>
    </div>
  `;

  const statsElement = container.querySelector('[data-street-directory-stats]');
  const listElement = container.querySelector('.street-directory-list');
  const scrollArea = container.querySelector('.street-directory-scroll');
  const sentinel = container.querySelector('.street-directory-sentinel');

  state.streetDirectory.statsElement = statsElement;
  state.streetDirectory.listElement = listElement;
  state.streetDirectory.scrollArea = scrollArea;
  state.streetDirectory.sentinel = sentinel;

  if (state.streetDirectory.observer) {
    state.streetDirectory.observer.disconnect();
  }

  if (scrollArea && sentinel) {
    const observer = new IntersectionObserver(
      observerEntries => {
        observerEntries.forEach(entry => {
          if (entry.isIntersecting) {
            appendStreetDirectoryChunk();
          }
        });
      },
      { root: scrollArea, rootMargin: '0px 0px 320px 0px' }
    );
    observer.observe(sentinel);
    state.streetDirectory.observer = observer;
  } else {
    state.streetDirectory.observer = null;
  }

  const scrollButton = container.querySelector('.street-directory-scroll-top');
  if (scrollButton && scrollArea) {
    scrollButton.addEventListener('click', () => {
      scrollArea.scrollTo({ top: 0, behavior: 'smooth' });
      scrollArea.focus({ preventScroll: true });
    });
  }

  applyStreetFilter(previousQuery || '');
}

function updateStreetSearchControls() {
  const clearButton = elements.street.clearButton;
  if (!clearButton) return;
  const inputValue = elements.street.searchInput ? elements.street.searchInput.value.trim() : '';
  clearButton.disabled = !state.streetDirectory.query && !inputValue;
}

function updateStreetDirectoryStats() {
  const statsElement = state.streetDirectory.statsElement;
  if (!statsElement) return;

  if (!state.streetDirectory.totalCount) {
    statsElement.textContent = 'אין נתונים להצגה.';
    return;
  }

  const parts = [];
  if (state.streetDirectory.query) {
    const filteredCount = state.streetDirectory.filteredEntries.length;
    parts.push(`${filteredCount.toLocaleString()} תוצאות עבור "${state.streetDirectory.query}"`);
    parts.push(`מתוך ${state.streetDirectory.totalCount.toLocaleString()} שמות מנורמלים`);
    const topMatch = state.streetDirectory.filteredEntries[0];
    if (topMatch) {
      parts.push(
        `התוצאה השכיחה ביותר: ${topMatch.display} (${topMatch.cityCount.toLocaleString()} ערים)`
      );
    }
  } else {
    parts.push(`${state.streetDirectory.totalCount.toLocaleString()} שמות מנורמלים`);
    if (state.streetDirectory.richestStreet) {
      parts.push(
        `השכיח ביותר: ${state.streetDirectory.richestStreet.display} (${state.streetDirectory.richestStreet.cityCount.toLocaleString()} ערים)`
      );
    }
    parts.push('ממוינים לפי מספר ערים (יורד)');
  }

  statsElement.textContent = parts.join(' · ');
}

function resetStreetDirectoryRender() {
  const directory = state.streetDirectory;
  if (!directory.listElement) return;

  if (directory.observer && directory.sentinel) {
    directory.observer.unobserve(directory.sentinel);
  }

  directory.listElement.innerHTML = '';
  directory.renderedCount = 0;

  if (!Array.isArray(directory.filteredEntries) || directory.filteredEntries.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'street-directory-placeholder';
    emptyItem.textContent = directory.query
      ? 'לא נמצאו רחובות תואמים.'
      : 'אין רחובות להצגה.';
    directory.listElement.appendChild(emptyItem);
    return;
  }

  appendStreetDirectoryChunk();

  if (directory.scrollArea) {
    let guard = 0;
    while (
      directory.renderedCount < directory.filteredEntries.length &&
      directory.scrollArea.scrollHeight <= directory.scrollArea.clientHeight + 80 &&
      guard < 12
    ) {
      const before = directory.renderedCount;
      appendStreetDirectoryChunk();
      if (directory.renderedCount === before) {
        break;
      }
      guard += 1;
    }
  }

  if (directory.observer && directory.sentinel && directory.renderedCount < directory.filteredEntries.length) {
    directory.observer.observe(directory.sentinel);
  }
}

function appendStreetDirectoryChunk() {
  const directory = state.streetDirectory;
  if (!directory.listElement || !Array.isArray(directory.filteredEntries)) return;

  if (directory.renderedCount >= directory.filteredEntries.length) {
    if (directory.observer && directory.sentinel) {
      directory.observer.unobserve(directory.sentinel);
    }
    return;
  }

  const nextCount = Math.min(
    directory.filteredEntries.length,
    directory.renderedCount + STREET_DIRECTORY_BATCH_SIZE
  );
  const fragment = document.createDocumentFragment();

  for (let index = directory.renderedCount; index < nextCount; index += 1) {
    const entry = directory.filteredEntries[index];
    if (!entry) continue;
    const listItem = document.createElement('li');
    listItem.className = 'street-directory-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'street-directory-link';
    button.dataset.streetKey = entry.key;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'street-directory-name';
    nameSpan.textContent = entry.display;

    const countSpan = document.createElement('span');
    countSpan.className = 'street-directory-count';
    countSpan.setAttribute('aria-label', `מופיע ב-${entry.cityCount.toLocaleString()} ערים`);
    countSpan.textContent = `${entry.cityCount.toLocaleString()} ערים`;

    button.append(nameSpan, countSpan);
    listItem.appendChild(button);
    fragment.appendChild(listItem);
  }

  directory.listElement.appendChild(fragment);
  directory.renderedCount = nextCount;

  if (directory.observer && directory.sentinel) {
    directory.observer.unobserve(directory.sentinel);
    if (directory.renderedCount < directory.filteredEntries.length) {
      directory.observer.observe(directory.sentinel);
    }
  }
}

function applyStreetFilter(rawQuery) {
  const directory = state.streetDirectory;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  directory.query = query;

  if (!Array.isArray(directory.entries) || directory.entries.length === 0) {
    directory.filteredEntries = [];
    directory.renderedCount = 0;
    resetStreetDirectoryRender();
    updateStreetDirectoryStats();
    updateStreetSearchControls();
    return;
  }

  let filtered = directory.entries;
  if (query) {
    if (state.fuse) {
      const results = state.fuse.search(query);
      if (results.length) {
        const keySet = new Set(
          results
            .map(result => {
              if (!result) return null;
              if (result.item && typeof result.item === 'object') {
                return result.item.key || result.item.normalized || null;
              }
              if (typeof result.item === 'string') return result.item;
              return null;
            })
            .filter(Boolean)
        );
        filtered = directory.entries.filter(entry => keySet.has(entry.key));
      } else {
        const baseQuery = query.toLowerCase();
        const normalizedQuery = query.replace(/\s+/g, '').toLowerCase();
        filtered = directory.entries.filter(entry => {
          const display = (entry.display || '').toLowerCase();
          const normalized = (entry.key || '').toLowerCase();
          return display.includes(baseQuery) || normalized.includes(normalizedQuery);
        });
      }
    } else {
      const baseQuery = query.toLowerCase();
      const normalizedQuery = query.replace(/\s+/g, '').toLowerCase();
      filtered = directory.entries.filter(entry => {
        const display = (entry.display || '').toLowerCase();
        const normalized = (entry.key || '').toLowerCase();
        return display.includes(baseQuery) || normalized.includes(normalizedQuery);
      });
    }
  }

  directory.filteredEntries = filtered;
  directory.renderedCount = 0;

  resetStreetDirectoryRender();
  updateStreetDirectoryStats();
  updateStreetSearchControls();
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
    updateStreetSearchControls();
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
        <strong>${formatRarityWeight(Number(entry.rarityWeight || 0), 1)}</strong>
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
      fallback.textContent = 'נתוני מיקום לערים אינם זמינים, ולכן שכבת המפה מושבתת.';
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
  } else if (view === 'city') {
    const primaryId = state.cityView?.primaryId || '';
    const secondaryId = state.cityView?.secondaryId || '';
    if (primaryId) {
      renderCity(primaryId, secondaryId || '');
    } else {
      renderCity('', '');
    }
  }
}

function init() {
  setupCityHandlers();
  setupStreetSearch();
  setupStreetDirectory();
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
