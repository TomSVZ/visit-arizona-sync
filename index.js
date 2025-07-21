// index.js for Google Cloud Function - Optimized with persistent storage

const algoliasearch = require('algoliasearch');
const { WebflowClient } = require('webflow-api');
const { Storage } = require('@google-cloud/storage');

// --- INITIALIZE CLIENTS ---
const algoliaClient = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_KEY);
const webflow = new WebflowClient({ accessToken: process.env.WEBFLOW_API_TOKEN });
const storage = new Storage();
const bucketName = process.env.GCS_BUCKET_NAME; // Add this to your environment variables

// --- WEBHOOK VERIFICATION ---
/**
 * Verifies Webflow webhook signature
 */
async function verifyWebflowSignature(req, triggerType) {
  const secretMap = {
    'collection_item_published': process.env.WEBFLOW_PUBLISH_SECRET,
    'collection_item_unpublished': process.env.WEBFLOW_UNPUBLISH_SECRET,
    'collection_item_deleted': process.env.WEBFLOW_DELETE_SECRET
  };

  const secret = secretMap[triggerType];

  if (!secret) {
    console.warn(`No secret configured for trigger type: ${triggerType}`);
    return false;
  }

  const isValidRequest = await webflow.webhooks.verifySignature({
    headers: req.headers,
    body: JSON.stringify(req.body),
    secret: getSigningSecret(secret)
  });

  return isValidRequest;
}

// --- PERSISTENT STORAGE ---
const CACHE_FILE = 'reference-cache.json';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days for persistent storage
// In-memory cache (warm container optimization)
let referenceCache = {};
let cacheTimestamp = 0;

/**
 * Loads cache from Google Cloud Storage
 */
async function loadCacheFromStorage() {
  try {
    const file = storage.bucket(bucketName).file(CACHE_FILE);
    const [exists] = await file.exists();

    if (!exists) {
      console.log('No persistent cache found, will build new one');
      return { cache: {}, timestamp: 0 };
    }

    const [data] = await file.download();
    const cacheData = JSON.parse(data.toString());

    // Check if persistent cache is still valid
    if (Date.now() - cacheData.timestamp < CACHE_TTL) {
      console.log('📦 Loaded valid cache from persistent storage');
      return { cache: cacheData.cache, timestamp: cacheData.timestamp };
    } else {
      console.log('💾 Persistent cache expired, will rebuild');
      return { cache: {}, timestamp: 0 };
    }
  } catch (error) {
    console.error('Failed to load cache from storage:', error.message);
    return { cache: {}, timestamp: 0 };
  }
}

/**
 * Saves cache to Google Cloud Storage
 */
async function saveCacheToStorage() {
  try {
    const file = storage.bucket(bucketName).file(CACHE_FILE);
    const cacheData = {
      cache: referenceCache,
      timestamp: cacheTimestamp
    };

    await file.save(JSON.stringify(cacheData), {
      metadata: { contentType: 'application/json' }
    });
    console.log('💾 Cache saved to persistent storage');
  } catch (error) {
    console.error('Failed to save cache to storage:', error.message);
  }
}

/**
 * Checks if the in-memory cache is still valid
 */
function isCacheValid() {
  return Date.now() - cacheTimestamp < CACHE_TTL && Object.keys(referenceCache).length > 0;
}

/**
 * Fetches a single reference item from Webflow and adds it to cache
 * @param {string} itemId - The Webflow item ID
 * @param {string} collectionId - The collection ID containing the item
 * @returns {Promise<object|null>} The item data or null if not found
 */
async function fetchAndCacheReferenceItem(itemId, collectionId) {
  try {
    const item = await webflow.collections.items.getItemLive(collectionId, itemId);

    // Initialize collection cache if it doesn't exist
    if (!referenceCache[collectionId]) {
      referenceCache[collectionId] = {};
    }

    // Cache the item
    const itemData = {
      name: item.fieldData.name,
      slug: item.fieldData.slug,
    };
    referenceCache[collectionId][itemId] = itemData;

    return itemData;
  } catch (error) {
    console.error(`❌ Failed to fetch reference item ${itemId}:`, error.message);
    return null;
  }
}

/**
 * Builds initial reference cache for all collections
 */
async function buildReferenceCache() {
  console.log('🏗️  Building reference cache...');
  const cache = {};
  const collectionIds = Object.values(CONFIG.tagCollections);
  let totalItems = 0;

  await Promise.all(
    collectionIds.map(async (collectionId) => {
      try {
        const items = await getAllWebflowItems(collectionId);
        cache[collectionId] = {};
        for (const item of items) {
          cache[collectionId][item.id] = {
            name: item.fieldData.name,
            slug: item.fieldData.slug,
          };
        }
        totalItems += items.length;
      } catch (error) {
        console.error(`Failed to build cache for collection ${collectionId}:`, error.message);
      }
    })
  );

  referenceCache = cache;
  cacheTimestamp = Date.now();

  // Save to persistent storage
  await saveCacheToStorage();

  console.log(`✅ Reference cache built with ${totalItems} total items`);
  return cache;
}

/**
 * Ensures reference cache is available and up-to-date
 */
async function ensureReferenceCache() {
  // First check in-memory cache
  if (isCacheValid()) {
    return;
  }

  // Try loading from persistent storage
  const { cache, timestamp } = await loadCacheFromStorage();
  if (Object.keys(cache).length > 0) {
    referenceCache = cache;
    cacheTimestamp = timestamp;
    return;
  }

  // Build new cache if nothing found
  await buildReferenceCache();
}

/**
 * Smart cache lookup that fetches missing items on-demand
 * @param {string[]} itemIds - Array of Webflow item IDs
 * @param {string} collectionId - The collection ID for the reference items
 * @param {string} field - The field to extract ('name' or 'slug')
 * @returns {Promise<string[]>} Array of names/slugs
 */
async function getReferencesWithFallback(itemIds, collectionId, field = 'name') {
  if (!itemIds || itemIds.length === 0) {
    return [];
  }

  // Ensure we have a cache
  await ensureReferenceCache();

  const results = [];
  const missingIds = [];

  // First pass: collect what we have and identify missing items
  for (const id of itemIds) {
    const cachedItem = referenceCache[collectionId]?.[id];
    if (cachedItem) {
      results.push(cachedItem[field]);
    } else {
      missingIds.push(id);
    }
  }

  // Second pass: fetch missing items in parallel
  if (missingIds.length > 0) {
    const fetchPromises = missingIds.map(id => fetchAndCacheReferenceItem(id, collectionId));
    const fetchedItems = await Promise.all(fetchPromises);

    // Add successfully fetched items to results and update persistent storage
    let newItemsAdded = 0;
    fetchedItems.forEach(item => {
      if (item && item[field]) {
        results.push(item[field]);
        newItemsAdded++;
      }
    });

    // Save updated cache to storage if we added new items
    if (newItemsAdded > 0) {
      await saveCacheToStorage();
    }
  }

  return results.filter(item => item != null);
}

// --- OPTIMIZED DATA TRANSFORMERS ---

const transformEvent = async (item) => {
  const { fieldData } = item;
  const startDate = fieldData['event-start-date'] ? new Date(fieldData['event-start-date']) : null;
  const endDate = fieldData['event-end-date'] ? new Date(fieldData['event-end-date']) : null;
  let dateInfo = {};

  if (startDate) {
    dateInfo = {
      startTimestamp: Math.floor(startDate.getTime() / 1000),
      startYear: startDate.getUTCFullYear(),
      startMonth: startDate.getUTCMonth() + 1,
      startDay: startDate.getUTCDate(),
    };
  }
  if (endDate) {
    dateInfo = {
      ...dateInfo,
      endTimestamp: Math.floor(endDate.getTime() / 1000),
      endYear: endDate.getUTCFullYear(),
      endMonth: endDate.getUTCMonth() + 1,
      endDay: endDate.getUTCDate(),
    };
  }

  // Parallel reference lookups
  const [categories, highlightTags, regions, cities] = await Promise.all([
    getReferencesWithFallback([].concat(fieldData.categories || []), CONFIG.tagCollections.categories, 'slug'),
    getReferencesWithFallback([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, 'slug'),
    getReferencesWithFallback([].concat(fieldData.regions || []), CONFIG.tagCollections.regions, 'slug'),
    getReferencesWithFallback([].concat(fieldData['cities-towns'] || []), CONFIG.placeCollections['cities-towns'].collectionId, 'slug')
  ]);

  return {
    objectID: item.id,
    Name: fieldData.name || null,
    description: fieldData['body-content'] || null,
    webflowLink: `/events/${fieldData.slug}`,
    thumbnailImage: fieldData['main-image']?.url || null,
    thumbnailAltText: fieldData['main-image']?.alt || null,
    _geoloc: (fieldData['google-maps-latitude'] && fieldData['google-maps-longitude']) ? {
      lat: parseFloat(fieldData['google-maps-latitude']),
      lng: parseFloat(fieldData['google-maps-longitude']),
    } : null,
    ...dateInfo,
    locationName: fieldData['location-name'] || null,
    openingHours: fieldData['opening-hours'] || null,
    eventAdmission: fieldData['event-admission'] || null,
    Categories: categories,
    highlightTags: highlightTags,
    Regions: regions,
    Cities: cities,
  };
};

const transformLikeALocal = async (item) => {
  const { fieldData } = item;

  // Parallel reference lookups
  const [categories, highlightTags, regions, cities] = await Promise.all([
    getReferencesWithFallback([].concat(fieldData.categories || []), CONFIG.tagCollections.categories, 'slug'),
    getReferencesWithFallback([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, 'slug'),
    getReferencesWithFallback([].concat(fieldData.regions || []), CONFIG.tagCollections.regions, 'slug'),
    getReferencesWithFallback([].concat(fieldData.cities || []), CONFIG.placeCollections['cities-towns'].collectionId, 'slug')
  ]);

  return {
    objectID: item.id,
    Name: fieldData.name || null,
    description: fieldData.introduction || null,
    webflowLink: `/like-a-local/${fieldData.slug}`,
    thumbnailImage: fieldData['main-image']?.url || null,
    thumbnailAltText: fieldData['main-image-alt-text'] || fieldData['main-image']?.alt || null,
    Categories: categories,
    highlightTags: highlightTags,
    Regions: regions,
    Cities: cities,
  };
};

const transformExperience = async (item) => {
  const { fieldData } = item;

  // Parallel reference lookups
  const [categories, highlightTags, regions, cities, amenities] = await Promise.all([
    getReferencesWithFallback([].concat(fieldData.categories || []), CONFIG.tagCollections.categories, 'slug'),
    getReferencesWithFallback([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, 'slug'),
    getReferencesWithFallback([].concat(fieldData.regions || []), CONFIG.tagCollections.regions, 'slug'),
    getReferencesWithFallback([].concat(fieldData.cities || []), CONFIG.placeCollections['cities-towns'].collectionId, 'slug'),
    getReferencesWithFallback([].concat(fieldData.amenities || []), CONFIG.tagCollections.amenities, 'slug')
  ]);

  return {
    objectID: item.id,
    Name: fieldData.name || null,
    description: fieldData['text-summary'] || null,
    webflowLink: `/directory/${fieldData.slug}`,
    thumbnailImage: fieldData['main-image']?.url || null,
    thumbnailAltText: fieldData['main-image']?.alt || null,
    _geoloc: (fieldData['latitude'] && fieldData['longitude']) ? {
      lat: parseFloat(fieldData['latitude']),
      lng: parseFloat(fieldData['longitude']),
    } : null,
    Categories: categories,
    highlightTags: highlightTags,
    Regions: regions,
    Cities: cities,
    Amenities: amenities,
  };
};

const transformPlace = async (item, placeType) => {
  const { fieldData } = item;
  const toTitleCase = (str) => str ? str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : null;

  // Parallel reference lookups
  const [region, highlightTags] = await Promise.all([
    getReferencesWithFallback([fieldData.region], CONFIG.tagCollections.regions, 'slug'),
    getReferencesWithFallback([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, 'slug')
  ]);

  return {
    objectID: item.id,
    Name: toTitleCase(fieldData.name),
    description: fieldData['sub-heading'] || null,
    webflowLink: `/places/${placeType}/${fieldData.slug}`,
    thumbnailImage: fieldData['hero-background-image']?.url || null,
    thumbnailAltText: fieldData['hero-background-image-alt-tag'] || null,
    _geoloc: (fieldData['google-map-latitude'] && fieldData['google-map-longitude']) ? {
      lat: parseFloat(fieldData['google-map-latitude']),
      lng: parseFloat(fieldData['google-map-longitude']),
    } : null,
    placeType: placeType,
    Region: region[0] || null,
    highlightTags: highlightTags,
    slug: fieldData.slug,
  };
};

// --- CONFIGURATION OBJECT ---
const CONFIG = {
  tagCollections: {
    categories: '683a4969614808c01cd0d48d',
    highlightTags: '683a4969614808c01cd0d4be',
    amenities: '683bad94ae45c6b733768887',
    regions: '683a4969614808c01cd0d4d3',
  },
  collectionMappings: {
    '683a4969614808c01cd0d408': { indexName: 'testing_cms_items', transformer: transformEvent },
    '683a4969614808c01cd0d443': { indexName: 'testing_cms_items_2', transformer: transformLikeALocal },
    '683a4969614808c01cd0d41f': { indexName: 'testing_cms_items', transformer: transformExperience },
  },
  placeCollections: {
    'cities-towns': { collectionId: '683a4969614808c01cd0d51f', placeType: 'cities' },
    'rivers-lakes': { collectionId: '683a4969614808c01cd0d500', placeType: 'rivers-lakes' },
    'parks-monuments': { collectionId: '683a4969614808c01cd0d535', placeType: 'parks-monuments' },
    'american-indians': { collectionId: '683a4969614808c01cd0d555', placeType: 'american-indian' },
  }
};

// Add place collections to the main mapping dynamically
for (const key in CONFIG.placeCollections) {
  const { collectionId, placeType } = CONFIG.placeCollections[key];
  CONFIG.collectionMappings[collectionId] = {
    indexName: 'testing_cms_items',
    transformer: (item) => transformPlace(item, placeType),
  };
}

/**
 * Fetches all items from a Webflow collection with pagination
 */
async function getAllWebflowItems(collectionId) {
  const allItems = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { items } = await webflow.collections.items.listItemsLive(collectionId, { limit, offset });
    if (items.length === 0) break;
    allItems.push(...items);
    offset += limit;
  }
  return allItems;
}

/**
 * Optimized full sync with better performance monitoring
 */
async function handleFullSync() {
  const startTime = Date.now();
  console.log('🚀 Starting optimized full sync...');

  // Force fresh cache for full sync
  await buildReferenceCache();

  const recordsByIndex = {};
  const collectionTimes = {};

  // Process all collections in parallel with timing
  await Promise.all(Object.entries(CONFIG.collectionMappings).map(async ([collectionId, mapping]) => {
    const collectionStart = Date.now();
    try {
      const webflowItems = await getAllWebflowItems(collectionId);
      const fetchTime = Date.now() - collectionStart;

      // Transform items in parallel
      const transformStart = Date.now();
      const transformedRecords = await Promise.all(
        webflowItems.map(item => mapping.transformer(item))
      );
      const transformTime = Date.now() - transformStart;

      if (!recordsByIndex[mapping.indexName]) {
        recordsByIndex[mapping.indexName] = [];
      }
      recordsByIndex[mapping.indexName].push(...transformedRecords);

      const totalTime = Date.now() - collectionStart;
      collectionTimes[collectionId] = {
        items: webflowItems.length,
        fetchTime,
        transformTime,
        totalTime
      };

      console.log(`  ✅ Collection ${collectionId}: ${webflowItems.length} items in ${totalTime}ms (fetch: ${fetchTime}ms, transform: ${transformTime}ms)`);
    } catch (error) {
      console.error(`❌ Failed to process collection ${collectionId}:`, error);
    }
  }));

  // Update Algolia indexes with timing
  console.log('📡 Updating Algolia indexes...');
  const algoliaStart = Date.now();

  await Promise.all(Object.entries(recordsByIndex).map(async ([indexName, records]) => {
    if (records.length === 0) return;

    try {
      const index = algoliaClient.initIndex(indexName);
      await index.replaceAllObjects(records, { autoGenerateObjectIDIfNotExist: false });
      console.log(`✨ Synced ${records.length} records to ${indexName}`);
    } catch (error) {
      console.error(`❌ Failed to sync index ${indexName}:`, error);
    }
  }));

  const algoliaTime = Date.now() - algoliaStart;
  const totalTime = Date.now() - startTime;

  console.log(`🎉 Full sync complete in ${totalTime}ms (Algolia upload: ${algoliaTime}ms)`);

  // Performance breakdown
  const slowestCollection = Object.entries(collectionTimes)
    .sort(([, a], [, b]) => b.totalTime - a.totalTime)[0];

  if (slowestCollection) {
    const [id, times] = slowestCollection;
    console.log(`⚠️  Slowest collection: ${id} (${times.totalTime}ms for ${times.items} items)`);
  }
}

// --- MAIN CLOUD FUNCTION ---
exports.webflowToAlgolia = async (req, res) => {
  const startTime = Date.now();
  const { triggerType } = req.body;

  // Verify webhook signature for Webflow triggers
  if (triggerType && triggerType !== 'manual_sync_all') {
    if (!(await verifyWebflowSignature(req, triggerType))) {
      console.warn('❌ Invalid webhook signature');
      return res.status(401).send('Invalid signature');
    }
  }

  // Authorization check for manual sync
  if (triggerType === 'manual_sync_all') {
    if (req.body.secret !== process.env.SYNC_SECRET) {
      console.warn('❌ Unauthorized manual sync attempt');
      return res.status(401).send('Unauthorized');
    }
  }

  console.log(`🚀 Processing: ${triggerType || 'unknown'}`);

  // Respond immediately
  res.status(202).send('Request accepted. Processing in background.');

  try {
    const { payload } = req.body;

    if (triggerType === 'manual_sync_all') {
      await handleFullSync();

    } else if (triggerType === 'collection_item_deleted' || triggerType === 'collection_item_unpublished') {
      const { id: itemId, collectionId } = payload;
      if (!itemId || !collectionId) {
        console.warn('⚠️  Delete trigger missing required IDs');
        return;
      }

      const mapping = CONFIG.collectionMappings[collectionId];
      if (!mapping) {
        console.warn(`⚠️  No mapping found for collection: ${collectionId}`);
        return;
      }

      const algoliaIndex = algoliaClient.initIndex(mapping.indexName);
      await algoliaIndex.deleteObject(itemId);
      console.log(`🗑️  Deleted item ${itemId} from ${mapping.indexName}`);

    } else if (triggerType === 'collection_item_published') {
      const itemsToProcess = payload.items || [];
      if (itemsToProcess.length === 0) {
        console.log('⚠️  No items to process');
        return;
      }

      // Process items in parallel
      await Promise.all(itemsToProcess.map(async (itemSummary) => {
        const { id: itemId, collectionId } = itemSummary;
        const mapping = CONFIG.collectionMappings[collectionId];

        if (!mapping) {
          console.warn(`⚠️  No mapping for item ${itemId} in collection ${collectionId}`);
          return;
        }

        try {
          const algoliaIndex = algoliaClient.initIndex(mapping.indexName);
          const item = await webflow.collections.items.getItemLive(collectionId, itemId);
          const algoliaRecord = await mapping.transformer(item);

          await algoliaIndex.saveObject(algoliaRecord);
          console.log(`✅ Indexed item ${itemId}`);
        } catch (error) {
          console.error(`❌ Failed to process item ${itemId}:`, error);
        }
      }));

      console.log(`✅ Processed ${itemsToProcess.length} items in ${Date.now() - startTime}ms`);
    }
  } catch (error) {
    console.error('❌ Function error:', error);
  }
};