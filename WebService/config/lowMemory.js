const lowMemoryMode = process.env.LOW_MEMORY_MODE?.trim().toLowerCase() === 'true';
const lowMemoryText = process.env.LOW_MEMORY_TEXT?.trim()
    || 'Wegen reduzierter Serverressourcen sind speicherintensive Statistiken vorübergehend deaktiviert.';

module.exports = { lowMemoryMode, lowMemoryText };
