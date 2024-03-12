const db = require('pg');
const { SQLError } = require('@lib/errors');

const pool = new db.Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
})

const createTables = async () => {
  await createTable(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`, "uuid-ossp extension");
  // Create User Table
  await createTable(`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    puuid UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    username text UNIQUE,
    time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`, "users")
  // Create Webtoken Table
  await createTable(`CREATE TABLE IF NOT EXISTS webtokens (
      user_id integer,
      token text PRIMARY KEY,
      browser text,
      time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);`, "webtokens");
}

/**
 * Create a new table
 * @param {String} query 
 * @param {String} table 
 * @returns 
 */
const createTable = (query, table) => {
  return new Promise((resolve, reject) => {
    pool.query(query, (err, result) => {
      if (err) { process.log.error(`Table-gen: Error ${table}: ${err}`) }
      if (err) reject();
      resolve(result);
    });
  })
}

/* --- --- --- --- --- Querys --- --- --- --- --- */

/* --- --- --- Webtokens --- --- --- */

/**
 * Insert a new Webtoken
 * @param {Number} user_id
 * @param {String} token
 * @param {String} browser
 * @returns 
 */
const WebtokensCreate = (user_id, token, browser) => {
  return new Promise((resolve, reject) => {
    pool.query(`INSERT INTO webtokens (user_id, token, browser) VALUES ($1, $2, $3)`, [user_id, token, browser], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Get data from a Webtoken
 * @param {String} token 
 * @returns 
 */
const WebtokensGet = (token) => {
  return new Promise((resolve, reject) => {
    // Join the users, userssettings table with the webtokens table
    pool.query(`SELECT webtokens.user_id, webtokens.token, webtokens.browser, webtokens.time, users_settings.design, users_settings.language, users.puuid, users.username, users.user_group, users.avatar_url FROM webtokens INNER JOIN users ON webtokens.user_id = users.id INNER JOIN users_settings ON webtokens.user_id = users_settings.user_id WHERE token = $1`, [token], (err, result) => {
      if (err) { reject(err) }
      resolve(result.rows)
    })
  })
}

/**
 * Remove a Webtoken from the database
 * @param {String} token 
 * @returns 
 */
const WebtokensDelete = (token) => {
  return new Promise((resolve, reject) => {
    pool.query(`DELETE FROM webtokens WHERE token = $1`, [token], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/* --- --- --- Exports --- --- --- */

const webtoken = {
  create: WebtokensCreate,
  get: WebtokensGet,
  delete: WebtokensDelete
}


module.exports = {
  createTables,
}