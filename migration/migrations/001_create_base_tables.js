const id = '001_create_base_tables';

const up = async (ch) => {
    await ch.exec({
        query: `
            CREATE TABLE IF NOT EXISTS haltestellen (
                VGNKennung       Int16,
                VAGKennung       Array(String),
                Haltestellenname String,
                Latitude         Float64,
                Longitude        Float64,
                Produkt_Bus      UInt8,
                Produkt_UBahn    UInt8,
                Produkt_Tram     UInt8,
                Produkt_SBahn    UInt8,
                Produkt_RBahn    UInt8,
                _updated_at      DateTime DEFAULT now()
            ) ENGINE = ReplacingMergeTree(_updated_at)
            ORDER BY VGNKennung
        `,
    });

    await ch.exec({
        query: `
            CREATE TABLE IF NOT EXISTS fahrten (
                Fahrtnummer    Int32,
                Betriebstag    Date,
                Produkt        Int8,
                Linienname     String,
                Besetzungsgrad Int8,
                Fahrzeugnummer Int32,
                Richtung       Int8,
                FaelltAus      UInt8 DEFAULT 0,
                _updated_at    DateTime DEFAULT now()
            ) ENGINE = ReplacingMergeTree(_updated_at)
            PARTITION BY toYYYYMM(Betriebstag)
            ORDER BY (Betriebstag, Fahrtnummer, Produkt)
        `,
    });

    await ch.exec({
        query: `
            CREATE TABLE IF NOT EXISTS fahrten_halte (
                Fahrtnummer              Int32,
                Betriebstag              Date,
                Produkt                  Int8,
                VGNKennung               Int16,
                Haltepunkt               Int16,
                Richtungstext            String,
                AnkunftszeitSoll         Nullable(DateTime),
                \`AnkunftszeitVerspätung\` Nullable(Int16),
                AbfahrtszeitSoll         Nullable(DateTime),
                \`AbfahrtszeitVerspätung\` Nullable(Int16),
                _updated_at              DateTime DEFAULT now()
            ) ENGINE = ReplacingMergeTree(_updated_at)
            PARTITION BY toYYYYMM(Betriebstag)
            ORDER BY (Betriebstag, VGNKennung, Fahrtnummer, Produkt)
        `,
    });
}

module.exports = {
    id,
    up,
}
