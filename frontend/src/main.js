// Main application entry point

// Define global data stores
let citiesData = null;
let similarityData = null;
let streetIndex = null;
let rarityWeights = null;

// Navigation function
function setupNavigation() {
  const navLinks = document.querySelectorAll('nav a');

  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();

      const view = e.target.getAttribute('href').substring(1);
      showView(view);
    });
  });
}

function showView(viewName) {
  const views = document.querySelectorAll('main div[id$="-view"]');

  views.forEach(view => {
    view.style.display = 'none';
    const viewElement = document.getElementById(`${view}-view`);
    if (viewElement && viewElement.classList) {
      viewElement.classList.remove('active');
    }
  });

  const activeView = document.getElementById(`${viewName}-view`);
  if (activeView) {
    activeView.style.display = 'block';
    activeView.classList.add('active');
  }
}

// Load data from JSON files
async function loadData() {
  try {
    showLoading(true);

    // Load all required data files
    const [cities, similarities, streetIdx, rarity] = await Promise.all([
      fetch('data/processed/cities.json').then(r => r.json()),
      fetch('data/processed/city_similarities.json').then(r => r.json()),
      fetch('data/processed/street_index.json').then(r => r.json()),
      fetch('data/processed/rarity_weights.json').then(r => r.json())
    ]);

    citiesData = cities;
    similarityData = similarities;
    streetIndex = streetIdx;
    rarityWeights = rarity;

    console.log('Data loading complete');
    showLoading(false);

    // Initialize views with data
    initHomeView();
    initCityView();
    initStreetView();

  } catch (error) {
    console.error('Error loading data:', error);
    showLoading(false);
    showError('Failed to load data. Please ensure the server is running or files are accessible.');
  }
}

function showLoading(show) {
  let loading = document.getElementById('loading');
  if (!loading) {
    loading = document.createElement('div');
    loading.id = 'loading';
    loading.innerHTML = '<div class="spinner"></div><p>Loading data...</p>';
    loading.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(0,0,0,0.8); color: white; padding: 20px; border-radius: 10px;
      z-index: 1000; text-align: center;
    `;
    document.body.appendChild(loading);
  }
  loading.style.display = show ? 'block' : 'none';
}

function showError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.id = 'error';
  errorDiv.innerHTML = `<p>❌ ${message}</p>`;
  errorDiv.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: #ff4747; color: white; padding: 15px; border-radius: 5px;
    z-index: 1001; text-align: center;
  `;
  document.body.appendChild(errorDiv);
  setTimeout(() => errorDiv.remove(), 5000);
}

// Initialize the application
async function init() {
  console.log('Initializing Street Name Similarity App');

  await loadData();
  setupNavigation();

  // Show home view by default
  showView('home');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
