// index.js for Google Cloud Function

const algoliasearch = require('algoliasearch');
const { WebflowClient } = require('webflow-api');

// --- INITIALIZE CLIENTS ---
// Securely access your API keys from environment variables
const algoliaClient = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_KEY);
const webflow = new WebflowClient({ accessToken: process.env.WEBFLOW_API_TOKEN });

/**
 * Fetches all items from all reference collections defined in the config.
 * @returns {Promise<object>} A promise that resolves to a cache object.
 * The cache is structured as: { collectionId: { itemId: itemName, ... }, ... }
 */
async function buildReferenceCache() {
  console.log('Building reference cache...');
  const cache = {};
  // Get all collection IDs from the tagCollections config
  const collectionIds = Object.values(CONFIG.tagCollections);

  await Promise.all(
    collectionIds.map(async (collectionId) => {
      try {
        const items = await getAllWebflowItems(collectionId);
        cache[collectionId] = {};
        for (const item of items) {
          // Store both the name and the slug for flexibility
          cache[collectionId][item.id] = {
            name: item.fieldData.name,
            slug: item.fieldData.slug,
          };
        }
      } catch (error) {
        console.error(`Failed to build cache for collection ${collectionId}:`, error.message);
      }
    })
  );
  console.log('✅ Reference cache built successfully.');
  return cache;
}

/**
 * Looks up reference item names/slugs from a pre-built cache.
 * @param {string[]} itemIds - An array of Webflow item IDs.
 * @param {string} collectionId - The Webflow collection ID for the reference items.
 * @param {object} cache - The pre-built cache from buildReferenceCache.
 * @param {string} field - The field to extract, 'name' or 'slug'.
 * @returns {string[]} An array of names/slugs.
 */
function getNamesFromCache(itemIds, collectionId, cache, field = 'name') {
  if (!itemIds || itemIds.length === 0 || !cache[collectionId]) {
    return [];
  }

  return itemIds
    .map((id) => cache[collectionId][id]?.[field]) // Safely access the name/slug
    .filter(name => name != null); // Filter out any not found
}

// --- DATA TRANSFORMERS ---
// This version ensures multi-reference fields are always arrays.

const transformEvent = (item, cache) => {
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
    Categories: getNamesFromCache([].concat(fieldData.categories || []), CONFIG.tagCollections.categories, cache, 'slug'),
    highlightTags: getNamesFromCache([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, cache, 'slug'),
    Regions: getNamesFromCache([].concat(fieldData.regions || []), CONFIG.tagCollections.regions, cache, 'slug'),
    Cities: getNamesFromCache([].concat(fieldData['cities-towns'] || []), CONFIG.placeCollections['cities-towns'].collectionId, cache, 'slug'),
  };
};

const transformLikeALocal = (item, cache) => {
  const { fieldData } = item;
  return {
    objectID: item.id,
    Name: fieldData.name || null,
    description: fieldData.introduction || null,
    webflowLink: `/like-a-local/${fieldData.slug}`,
    thumbnailImage: fieldData['main-image']?.url || null,
    thumbnailAltText: fieldData['main-image-alt-text'] || fieldData['main-image']?.alt || null,
    Categories: getNamesFromCache([].concat(fieldData.categories || []), CONFIG.tagCollections.categories, cache, 'slug'),
    highlightTags: getNamesFromCache([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, cache, 'slug'),
    Regions: getNamesFromCache([].concat(fieldData.regions || []), CONFIG.tagCollections.regions, cache, 'slug'),
    Cities: getNamesFromCache([].concat(fieldData.cities || []), CONFIG.placeCollections['cities-towns'].collectionId, cache, 'slug'),
  };
};

const transformExperience = (item, cache) => {
  const { fieldData } = item;
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
    Categories: getNamesFromCache([].concat(fieldData.categories || []), CONFIG.tagCollections.categories, cache, 'slug'),
    highlightTags: getNamesFromCache([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, cache, 'slug'),
    Regions: getNamesFromCache([].concat(fieldData.regions || []), CONFIG.tagCollections.regions, cache, 'slug'),
    Cities: getNamesFromCache([].concat(fieldData.cities || []), CONFIG.placeCollections['cities-towns'].collectionId, cache, 'slug'),
    Amenities: getNamesFromCache([].concat(fieldData.amenities || []), CONFIG.tagCollections.amenities, cache, 'slug'),
  };
};

const transformPlace = (item, placeType, cache) => {
  const { fieldData } = item;
  const toTitleCase = (str) => str ? str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : null;

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
    // This correctly remains a single value, as you requested.
    Region: (getNamesFromCache([fieldData.region], CONFIG.tagCollections.regions, cache, 'slug'))[0] || null,
    highlightTags: getNamesFromCache([].concat(fieldData['highlight-tags'] || []), CONFIG.tagCollections.highlightTags, cache, 'slug'),
    slug: fieldData.slug,
  };
}

// --- CONFIGURATION OBJECT ---
// Central hub for all mappings. Add new collections here.
const CONFIG = {
  tagCollections: {
    categories: '683a4969614808c01cd0d48d',
    highlightTags: '683a4969614808c01cd0d4be',
    amenities: '683bad94ae45c6b733768887',
    regions: '683a4969614808c01cd0d4d3',
  },
  // Map Webflow Collection IDs to their Algolia index and transformer
  collectionMappings: {
    '683a4969614808c01cd0d408': { indexName: 'testing_cms_items', transformer: transformEvent },
    '683a4969614808c01cd0d443': { indexName: 'testing_cms_items_2', transformer: transformLikeALocal },
    '683a4969614808c01cd0d41f': { indexName: 'testing_cms_items', transformer: transformExperience },
  },
  // Place collections have a special structure
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
    // Update the function signature here to pass the cache through
    transformer: (item, cache) => transformPlace(item, placeType, cache),
  };
}

/**
 * Fetches all items from a Webflow collection, automatically handling pagination.
 * @param {string} collectionId - The ID of the Webflow collection.
 * @returns {Promise<object[]>} A promise that resolves to an array of all items.
 */
async function getAllWebflowItems(collectionId) {
  const allItems = [];
  let offset = 0;
  const limit = 100; // Webflow's max limit per request

  while (true) {
    // Use the 'Live' version to get published items
    const { items } = await webflow.collections.items.listItemsLive(collectionId, { limit, offset });
    if (items.length === 0) {
      break; // No more items left
    }
    allItems.push(...items);
    offset += limit;
  }
  return allItems;
}

/**
* Performs a full synchronization of all configured Webflow collections to Algolia.
* It fetches all items, transforms them, groups them by index, and atomically updates each index.
*/
async function handleFullSync() {
  console.log('🚀 Starting full sync of all collections...');

  // Build the cache first!
  const referenceCache = await buildReferenceCache();

  const recordsByIndex = {};

  // 1. Fetch and transform all items from all collections concurrently
  await Promise.all(Object.entries(CONFIG.collectionMappings).map(async ([collectionId, mapping]) => {
    try {
      console.log(`⏳ Fetching & transforming items from collection: ${collectionId}`);
      const webflowItems = await getAllWebflowItems(collectionId);

      const transformedRecords = await Promise.all(
        webflowItems.map(item => mapping.transformer(item, referenceCache))
      );

      // Group records by their destination Algolia index name
      if (!recordsByIndex[mapping.indexName]) {
        recordsByIndex[mapping.indexName] = [];
      }
      recordsByIndex[mapping.indexName].push(...transformedRecords);
      console.log(`  ✅ Processed ${transformedRecords.length} items from ${collectionId} for index ${mapping.indexName}`);
    } catch (error) {
      console.error(`❌ Failed to process collection ${collectionId}:`, error);
    }
  }));

  // 2. Atomically update each Algolia index with the full set of records
  console.log('📡 Pushing aggregated records to Algolia...');
  await Promise.all(Object.entries(recordsByIndex).map(async ([indexName, records]) => {
    if (records.length === 0) {
      console.log(`- No records to sync for index ${indexName}. Skipping.`);
      return;
    }
    try {
      const index = algoliaClient.initIndex(indexName);
      // replaceAllObjects is atomic: it deletes all existing records 
      // and replaces them with the new set in a single, safe operation.
      await index.replaceAllObjects(records, {
        autoGenerateObjectIDIfNotExist: false // Your transformers correctly set the objectID
      });
      console.log(`✨ Successfully synced ${records.length} total records to index: ${indexName}`);
    } catch (error) {
      console.error(`❌ Failed to sync index ${indexName}:`, error);
    }
  }));

  console.log('🎉 Full sync complete!');
}

// --- MAIN CLOUD FUNCTION ---
/**
 * Handles Webflow webhooks AND manual triggers to sync data with Algolia.
 *
 * @param {object} req The HTTP request object.
 * @param {object} res The HTTP response object.
 */
exports.webflowToAlgolia = async (req, res) => {
  // For manual syncs, check for a secret key to prevent unauthorized execution.
  // The secret should be passed in the request body.
  if (req.body.triggerType === 'manual_sync_all') {
    if (req.body.secret !== process.env.SYNC_SECRET) {
      console.warn('Unauthorized manual_sync_all attempt received.');
      return res.status(401).send('Unauthorized');
    }
  }

  // Respond immediately to the caller to avoid timeouts.
  // The actual sync process will continue in the background.
  res.status(202).send('Request accepted. Processing will continue in the background.');

  try {
    const { triggerType, payload } = req.body;
    console.log(`Processing trigger: ${triggerType}`);

    // --- ROUTING LOGIC ---

    // NEW: Handle the manual full sync trigger
    if (triggerType === 'manual_sync_all') {
      await handleFullSync();

      // Case 1: An item was deleted or unpublished (existing logic)
    } else if (triggerType === 'collection_item_deleted' || triggerType === 'collection_item_unpublished') {
      const { id: itemId, collectionId } = payload;
      if (!itemId || !collectionId) {
        console.warn('Delete trigger received without required IDs. Skipping.');
        return;
      }
      const mapping = CONFIG.collectionMappings[collectionId];
      if (!mapping) {
        console.warn(`No mapping found for collection ID: ${collectionId}. Skipping delete.`);
        return;
      }
      const algoliaIndex = algoliaClient.initIndex(mapping.indexName);
      await algoliaIndex.deleteObject(itemId);
      console.log(`✅ Successfully deleted item ${itemId} from index ${mapping.indexName}.`);

      // Case 2: One or more items were published or created (existing logic)
    } else if (triggerType === 'collection_item_published' || triggerType === 'collection_item_created') {
      const itemsToProcess = payload.items || [];
      if (itemsToProcess.length === 0) {
        console.log('Publish trigger received with no items. Skipping.');
        return;
      }

      console.log(`🔄 Found ${itemsToProcess.length} item(s) to process.`);

      // --- FIX: Build the reference cache before processing the update ---
      const referenceCache = await buildReferenceCache();

      await Promise.all(itemsToProcess.map(async (itemSummary) => {
        const { id: itemId, collectionId } = itemSummary;
        const mapping = CONFIG.collectionMappings[collectionId];
        if (!mapping) {
          console.warn(`No mapping found for item ${itemId} in collection ${collectionId}. Skipping.`);
          return;
        }
        const algoliaIndex = algoliaClient.initIndex(mapping.indexName);
        const item = await webflow.collections.items.getItemLive(collectionId, itemId);

        // Pass the newly built cache to the transformer
        const algoliaRecord = mapping.transformer(item, referenceCache);

        await algoliaIndex.saveObject(algoliaRecord);
        console.log(`✅ Successfully indexed item ${itemId} to index ${mapping.indexName}.`);
      }));

      console.log('Finished processing batch.');
    }
  } catch (error) {
    console.error('Error processing request:', error);
  }
};