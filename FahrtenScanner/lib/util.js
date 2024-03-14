const { checkTripKey } = require('@lib/redis');

/**
 * Filter out duplicate Fahrten from the array (Checks against Redis Keys)
 * @param {Array} fahrten 
 * @returns 
 */
const filterDuplicates = async (fahrten) => {
    const checkPromises = fahrten.map(async (fahrt) => {
      const exists = await checkTripKey(fahrt.Fahrtnummer);
      return exists ? null : fahrt;
    });
  
    const results = await Promise.all(checkPromises);
    return results.filter((fahrt) => fahrt !== null);
  }

module.exports = {
    filterDuplicates
}