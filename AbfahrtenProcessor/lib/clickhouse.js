const { createClient } = require('@clickhouse/client');

const client = createClient({
    url: `http://${process.env.DB_HOST}:${process.env.DB_PORT || 8123}`,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

module.exports = { client };
