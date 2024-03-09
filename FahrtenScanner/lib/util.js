const { checkTripKey } = require('@lib/redis');

/**
 * Find the index of the first timestamp that is at least x seconds in the future.
 * @param {Array} timestamps Array of timestamps
 * @param {Number} minFuture Minimum time in milliseconds
 * @returns 
 */
const findFutureTimestampIndex = (timestamps, minFuture = 5000) => {
    const now = new Date();
    const futureTime = now.getTime() + minFuture;

    for (let i = 0; i < timestamps.length; i++) {
        let timestampStr = timestamps[i].AnkunftszeitSoll || timestamps[i].AbfahrtszeitSoll;
        if (timestampStr) {
            const timestamp = new Date(timestampStr);
            if (timestamp.getTime() > futureTime) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Filter out duplicate Fahrten from the array (Checks against Redis Keys)
 * @param {Array} fahrten 
 * @returns 
 */
const filterDuplicates = async (fahrten) => {
    // Use map to initiate a check for each item in the array
    const checkPromises = fahrten.map(async (fahrt) => {
      const exists = await checkTripKey(fahrt.Fahrtnummer);
      return exists ? null : fahrt; // Return null if exists, otherwise return the fahrt object
    });
  
    // Wait for all checks to complete
    const results = await Promise.all(checkPromises);
  
    // Filter out null values (duplicates) and return the remaining items
    return results.filter((fahrt) => fahrt !== null);
  }

module.exports = {
    findFutureTimestampIndex,
    filterDuplicates
}