const id = '003_create_connact_observations';

const up = async (ch) => {
    await ch.exec({
        query: `
            CREATE TABLE IF NOT EXISTS connact_temperature_observations (
                timestamp           DateTime64(3, 'UTC'),
                device              LowCardinality(String),
                sequence            UInt8,
                block_identifier    LowCardinality(String),
                rail_temperature    UInt8,
                ambient_temperature UInt8,
                raw_telegram        String,
                ingested_at         DateTime64(3, 'UTC') DEFAULT now64(3)
            ) ENGINE = ReplacingMergeTree(ingested_at)
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (device, timestamp)
        `,
    });
}

module.exports = {
    id,
    up,
}
