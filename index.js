// index.js - Main function compatible with both local and Google Cloud Function deployment

const algoliasearch = require('algoliasearch');
const { WebflowClient } = require('webflow-api');

// Conditional imports based on environment
let fs, path, storage, bucketName;

const isLocal = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'local';

if (isLocal) {
  // Local development - use file system
  fs = require('fs').promises;
  path = require('path');
} else {
  // Google Cloud Function - use Cloud Storage
  const { Storage } = require('@google-cloud/storage');
  storage = new Storage();
  bucketName = process.env.GCS_BUCKET_NAME;
}

// --- INITIALIZE CLIENTS ---
const algoliaClient = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_KEY);
const webflow = new WebflowClient({
  accessToken: process.env.WEBFLOW_API_TOKEN,
  maxRetries: 2,
  timeout: 60000 // Wait 60 seconds for a response from Webflow
});

// --- STORAGE ABSTRACTION LAYER ---
const CACHE_FILE = isLocal ?
  (path ? path.join(__dirname, 'reference-cache.json') : 'reference-cache.json') :
  'reference-cache.json';

let referenceCache = {};
let cacheLoaded = false;

/**
 * Processes an array of items in batches to avoid overwhelming APIs.
 * @param {Array<T>} items The array of items to process.
 * @param {number} batchSize The size of each chunk.
 * @param {Function} fn The async function to call for each item.
 * @returns {Promise<Array<R>>} A promise that resolves with an array of all results.
 * @template T, R
 */
async function processInBatches(items, batchSize, fn) {
  let results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results = results.concat(batchResults);
    // Optional: Add a small delay between batches if needed
    // if (i + batchSize < items.length) {
    //   await new Promise(resolve => setTimeout(resolve, 200));
    // }
  }
  return results;
}

/**
 * Load cache from storage (local file or GCS bucket)
 */
async function loadCacheFromStorage() {
  try {
    if (isLocal) {
      // Local file system
      const data = await fs.readFile(CACHE_FILE, 'utf8');
      const cacheData = JSON.parse(data);
      console.log('📦 Loaded cache from local file');
      return cacheData.cache || {};
    } else {
      // Google Cloud Storage
      const file = storage.bucket(bucketName).file(CACHE_FILE);
      const [exists] = await file.exists();

      if (!exists) {
        console.log('No cache found in GCS, will build new one');
        return {};
      }

      const [data] = await file.download();
      const cacheData = JSON.parse(data.toString());
      console.log('📦 Loaded cache from Google Cloud Storage');
      return cacheData.cache || {};
    }
  } catch (error) {
    if (isLocal && error.code === 'ENOENT') {
      console.log('No local cache found, will build new one');
    } else {
      console.error('Failed to load cache from storage:', error.message);
    }
    return {};
  }
}

/**
 * Save cache to storage (local file or GCS bucket)
 */
async function saveCacheToStorage() {
  try {
    const cacheData = {
      cache: referenceCache,
      timestamp: Date.now(),
      totalItems: Object.values(referenceCache).reduce((acc, collection) => acc + Object.keys(collection).length, 0)
    };

    if (isLocal) {
      // Local file system
      await fs.writeFile(CACHE_FILE, JSON.stringify(cacheData, null, 2));
      console.log(`💾 Cache saved to local file (${cacheData.totalItems} items)`);
    } else {
      // Google Cloud Storage
      const file = storage.bucket(bucketName).file(CACHE_FILE);
      await file.save(JSON.stringify(cacheData), {
        metadata: { contentType: 'application/json' }
      });
      console.log(`💾 Cache saved to GCS (${cacheData.totalItems} items)`);
    }
  } catch (error) {
    console.error('Failed to save cache to storage:', error.message);
  }
}

/**
 * Ensures reference cache is loaded (persistent, never expires)
 */
async function ensureReferenceCache() {
  if (cacheLoaded) {
    return;
  }

  referenceCache = await loadCacheFromStorage();

  // If cache is empty, build it
  if (Object.keys(referenceCache).length === 0) {
    await buildReferenceCache();
  }

  cacheLoaded = true;
}

/**
 * Fetches a single reference item from Webflow and adds it to cache
 */
async function fetchAndCacheReferenceItem(itemId, collectionId) {
  try {
    const item = await webflow.collections.items.getItemLive(collectionId, itemId);

    if (!referenceCache[collectionId]) {
      referenceCache[collectionId] = {};
    }

    const itemData = {
      name: item.fieldData.name,
      slug: item.fieldData.slug,
    };
    referenceCache[collectionId][itemId] = itemData;

    // Save immediately when new items are added
    await saveCacheToStorage();
    console.log(`✅ Cached new reference item: ${itemData.name}`);

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
        console.log(`  📋 Collection ${collectionId}: ${items.length} items`);
      } catch (error) {
        console.error(`Failed to build cache for collection ${collectionId}:`, error.message);
      }
    })
  );

  referenceCache = cache;
  await saveCacheToStorage();
  console.log(`✅ Reference cache built with ${totalItems} total items`);
}

/**
 * Smart cache lookup - cache grows organically, never clears
 */
async function getReferencesWithFallback(itemIds, collectionId, field = 'name') {
  if (!itemIds || itemIds.length === 0) {
    return [];
  }

  await ensureReferenceCache();

  const results = [];
  const missingIds = [];

  // First pass: collect cached items and identify missing ones
  for (const id of itemIds) {
    const cachedItem = referenceCache[collectionId]?.[id];
    if (cachedItem) {
      results.push(cachedItem[field]);
    } else {
      missingIds.push(id);
    }
  }

  // Second pass: fetch missing items (cache grows organically)
  if (missingIds.length > 0) {
    if (isLocal) {
      console.log(`🔍 Fetching ${missingIds.length} missing reference items in batches`);
    }

    // Use the batching function to avoid rate limits
    const BATCH_SIZE = 10; // Process 10 requests at a time
    const fetchedItems = await processInBatches(
      missingIds,
      BATCH_SIZE,
      id => fetchAndCacheReferenceItem(id, collectionId)
    );

    fetchedItems.forEach(item => {
      if (item && item[field]) {
        results.push(item[field]);
      }
    });
  }

  return results.filter(item => item != null);
}

// --- WEBHOOK VERIFICATION ---
async function verifyWebflowSignature(req, triggerType) {
  // Skip verification in local development
  if (isLocal) {
    console.log('🔓 Skipping webhook verification in development mode');
    return true;
  }

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

  try {
    const isValidRequest = await webflow.webhooks.verifySignature({
      headers: req.headers,
      body: JSON.stringify(req.body),
      secret: secret
    });
    return isValidRequest;
  } catch (error) {
    console.error('Webhook verification failed:', error.message);
    return false;
  }
}

// --- DATA TRANSFORMERS ---
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

// --- CONFIGURATION ---
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

// Add place collections to main mapping
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
 * Full sync handler
 */
async function handleFullSync() {
  const startTime = Date.now();
  console.log('🚀 Starting full sync...');

  await ensureReferenceCache();

  const recordsByIndex = {};
  const collectionTimes = {};

  for (const [collectionId, mapping] of Object.entries(CONFIG.collectionMappings)) {
    const collectionStart = Date.now();
    try {
      console.log(`⏳ Processing collection ${collectionId}...`);
      const webflowItems = await getAllWebflowItems(collectionId);
      const BATCH_SIZE = 10; // Process 10 items at a time.
      const transformedRecords = await processInBatches(
        webflowItems,
        BATCH_SIZE,
        item => mapping.transformer(item)
      );

      if (!recordsByIndex[mapping.indexName]) {
        recordsByIndex[mapping.indexName] = [];
      }
      recordsByIndex[mapping.indexName].push(...transformedRecords);

      const totalTime = Date.now() - collectionStart;
      collectionTimes[collectionId] = { items: webflowItems.length, totalTime };
      console.log(`  ✅ Collection ${collectionId}: ${webflowItems.length} items in ${totalTime}ms`);
    } catch (error) {
      console.error(`❌ Failed to process collection ${collectionId}:`, error.message || error);
    }
  }

  // Update Algolia
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

  console.log(`🎉 Full sync complete in ${Date.now() - startTime}ms`);
}

// --- MAIN CLOUD FUNCTION ---
exports.webflowToAlgolia = async (req, res) => {
  const startTime = Date.now();
  const { triggerType } = req.body;

  // Verify webhook signature for non-manual triggers
  if (triggerType && triggerType !== 'manual_sync_all') {
    if (!(await verifyWebflowSignature(req, triggerType))) {
      console.warn('❌ Invalid webhook signature');
      return res.status(401).send('Invalid signature');
    }
  }

  // Auth check for manual sync
  if (triggerType === 'manual_sync_all') {
    if (req.body.secret !== process.env.SYNC_SECRET) {
      console.warn('❌ Unauthorized manual sync attempt');
      return res.status(401).send('Unauthorized');
    }
  }

  console.log(`🚀 Processing: ${triggerType || 'unknown'}`);
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

// --- LOCAL DEVELOPMENT HELPERS ---
if (isLocal) {
  // Export additional helpers for local testing
  exports.getCacheStatus = async () => {
    await ensureReferenceCache();
    const totalItems = Object.values(referenceCache).reduce((acc, collection) => acc + Object.keys(collection).length, 0);

    return {
      loaded: cacheLoaded,
      totalCollections: Object.keys(referenceCache).length,
      totalItems,
      collections: Object.fromEntries(
        Object.entries(referenceCache).map(([id, items]) => [id, Object.keys(items).length])
      )
    };
  };

  exports.rebuildCache = async () => {
    console.log('🔄 Manual cache rebuild requested');
    referenceCache = {};
    cacheLoaded = false;
    await buildReferenceCache();
    return { success: true, message: 'Cache rebuilt successfully' };
  };

  exports.testSync = async () => {
    console.log('🧪 Test sync requested');
    await handleFullSync();
    return { success: true, message: 'Test sync completed' };
  };
}