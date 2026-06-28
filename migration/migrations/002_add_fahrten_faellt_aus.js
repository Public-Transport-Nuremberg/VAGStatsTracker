const id = '002_add_fahrten_faellt_aus';

const up = async (ch) => {
    await ch.exec({
        query: 'ALTER TABLE fahrten ADD COLUMN IF NOT EXISTS FaelltAus UInt8 DEFAULT 0 AFTER Richtung',
    });
}

module.exports = {
    id,
    up,
}
