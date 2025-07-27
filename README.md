# Visit Arizona - Webflow to Algolia Sync

A serverless Google Cloud Function that automatically syncs CMS content from Webflow to Algolia search indices. This function handles real-time updates via webhooks and supports full synchronization for bulk operations.

## 🏗️ Architecture

### Workflow
```
Local IDE (VSCode) → git push to master → Google GitHub App → Google Cloud Build → GCB installs npm packages → Creates/updates Cloud Function → Zero-downtime deployment
```

### Data Flow
1. **Webflow CMS**: Editor publishes, unpublishes, or deletes CMS items
2. **Webhook**: Webflow sends webhook to our function endpoint
3. **Processing**: Function either deletes objects (for unpublish/delete) or fetches data via Webflow API (for publish)
4. **Indexing**: Algolia updates search indices via API

## ☁️ Google Cloud Function Specifications

- **Runtime**: Node.js (serverless)
- **Scaling**: Min instances = 0 (cold start ~5s), auto-scales based on demand
- **Resources**: 2GB RAM, 2 vCPUs (probably overkill for current load)
- **Deployment**: Zero-downtime hot-swapping via Google Cloud Build

## 📊 Supported Content Types

The function syncs the following Webflow collections to corresponding Algolia indices:

| Content Type | Webflow Collection ID | Algolia Index | Features |
|--------------|----------------------|---------------|----------|
| Events | `683a4969614808c01cd0d408` | `events_cms_items` | Date handling, geolocation, categories |
| Like a Local | `683a4969614808c01cd0d443` | `like_a_local_cms_items` | Categories, regions, highlights |
| Experiences | `683a4969614808c01cd0d41f` | `experiences_cms_items` | Geolocation, amenities, categories |
| Cities/Towns | `683a4969614808c01cd0d51f` | `places_cms_items` | Geographic data, regions |
| Rivers/Lakes | `683a4969614808c01cd0d500` | `places_cms_items` | Geographic data |
| Parks/Monuments | `683a4969614808c01cd0d535` | `places_cms_items` | Geographic data |
| American Indians | `683a4969614808c01cd0d555` | `places_cms_items` | Geographic data |

## 🔧 Environment Variables

### Required for Production
```bash
# Algolia Configuration
ALGOLIA_APP_ID=your_algolia_app_id
ALGOLIA_ADMIN_KEY=your_algolia_admin_key

# Webflow Configuration
WEBFLOW_API_TOKEN=your_webflow_api_token

# Webhook Security
WEBFLOW_PUBLISH_SECRET=your_publish_webhook_secret
WEBFLOW_UNPUBLISH_SECRET=your_unpublish_webhook_secret
WEBFLOW_DELETE_SECRET=your_delete_webhook_secret

# Manual Sync Security
SYNC_SECRET=your_manual_sync_secret

# Google Cloud Storage (for cache)
GCS_BUCKET_NAME=your_storage_bucket_name
```

### Development
```bash
NODE_ENV=development  # or 'local'
```

## 🚀 Deployment

### Automatic Deployment
1. Push code to `master` branch
2. Google GitHub App triggers Cloud Build
3. Cloud Build uses `cloudbuild.yaml` configuration
4. Function is deployed with zero downtime

### Manual Deployment
```bash
# Deploy directly via gcloud CLI
gcloud functions deploy webflowToAlgolia \
  --runtime nodejs18 \
  --trigger-http \
  --allow-unauthenticated \
  --memory 2GB \
  --timeout 540s
```

## 📡 API Endpoints

### Webhook Endpoint
```
POST /webflowToAlgolia
```

#### Supported Trigger Types:
- `collection_item_published` - Sync new/updated items
- `collection_item_unpublished` - Remove items from index
- `collection_item_deleted` - Remove items from index
- `manual_sync_all` - Full synchronization (requires auth)

#### Manual Full Sync Example:
```bash
curl -X POST https://your-function-url/webflowToAlgolia \
  -H "Content-Type: application/json" \
  -d '{
    "triggerType": "manual_sync_all",
    "secret": "your_sync_secret"
  }'
```

## 🧪 Local Development

### Setup
```bash
# Install dependencies
npm install

# Set environment variables
export NODE_ENV=development
export ALGOLIA_APP_ID=your_app_id
# ... other environment variables

# Run locally (if you have local server setup)
node index.js
```

### Local Testing Functions
When running in development mode, additional helper functions are available:

```javascript
// Check cache status
const status = await exports.getCacheStatus();

// Rebuild reference cache
const result = await exports.rebuildCache();

// Test full sync
const syncResult = await exports.testSync();
```

## 🔄 Caching Strategy

The function implements an intelligent caching system:

- **Persistent Cache**: Reference data (categories, tags, regions) stored in Google Cloud Storage
- **Organic Growth**: Cache grows as new references are encountered
- **Never Expires**: Cache persists across function instances
- **Fallback Strategy**: Missing items are fetched individually and added to cache

### Cache Storage
- **Production**: Google Cloud Storage bucket
- **Development**: Local JSON file (`reference-cache.json`)

## 📈 Performance Features

- **Batch Processing**: Processes items in configurable batches (default: 10)
- **Parallel Execution**: Concurrent API calls where possible
- **Rate Limiting**: Built-in protection against API limits
- **Smart Caching**: Reduces redundant API calls
- **Error Handling**: Graceful degradation on failures

## 🔐 Security

- **Webhook Verification**: Validates Webflow webhook signatures
- **Secret Authentication**: Manual sync requires secret token
- **Environment Isolation**: Different configs for dev/prod

## 📚 Key Files

- `index.js` - Main function code
- `cloudbuild.yaml` - Google Cloud Build configuration
- `package.json` - Dependencies and metadata

## 🐛 Troubleshooting

### Common Issues

1. **Cold Start Timeout**: First request after idle period may take ~5s
2. **Rate Limits**: Function includes built-in batching and delays
3. **Cache Miss**: Reference items are fetched on-demand if not cached
4. **Webhook Verification**: Ensure correct secrets are configured

### Monitoring
- Check Google Cloud Function logs for detailed execution information
- Monitor Algolia dashboard for indexing success/failures
- Verify webhook delivery in Webflow settings

## 🔄 Cache Management

The function automatically manages reference data caching:
- Loads existing cache on startup
- Builds new cache if none exists
- Saves cache after processing
- Fetches missing references on-demand

Cache includes data for:
- Categories (`683a4969614808c01cd0d48d`)
- Highlight Tags (`683a4969614808c01cd0d4be`)
- Amenities (`683bad94ae45c6b733768887`)
- Regions (`683a4969614808c01cd0d4d3`) 