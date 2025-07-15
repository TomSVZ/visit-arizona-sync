/**
 * HTTP Cloud Function.
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.webflowAlgoliaSync = (req, res) => {
  console.log("Sync function triggered!");
  // Your logic to sync Webflow to Algolia will go here.
  res.status(200).send("Hello from Algolia Sync!");
};