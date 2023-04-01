const pg = require('pg');

const pool = new pg.Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
})

/* ------------------------------------ Users ------------------------------------ */

/**
 * The uuser table stores the user data.
 */
pool.query(`CREATE TABLE IF NOT EXISTS uuser (
    username text PRIMARY KEY,
    password text,
    2fa_secret text,
    language text,
    time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)`, (err, result) => {
  if (err) { process.log.error(`Error: Create uuser table: ${err}`) }
});

/**
 * The permissions table stores the permissions for each user.
 */
pool.query(`CREATE TABLE IF NOT EXISTS permissions (
  username text PRIMARY KEY,
  permission text,
  read boolean,
  write boolean,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)`, (err, result) => {
  if (err) { process.log.error(`Error: Create permissions table: ${err}`) }
});

/* ------------------------------------ Webauth ------------------------------------ */

/**
 * The webtoken table stores the webtoken for each user.
 */
pool.query(`CREATE TABLE IF NOT EXISTS webtoken (
  username text,
  ip INET,
  browser text,
  token text PRIMARY KEY,
  lang text,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP)`, (err, result) => {
  if (err) { log.error(`DB Create webtoken: ${err}`) }
});

/* ------------------------------------ Elevator ------------------------------------ */

/**
 * The outages table stores the outages of all elevators.
 * time_mark is year.quarter (2023.1)
 * station is the station name
 * name is the elevator name
 * total is the total number of outages within the time_mark
 * d_0 - d_23 is the number of outages within the time_mark for each hour
 * time is the time the data was added to the database
 */
pool.query(`CREATE TABLE IF NOT EXISTS elevator_outages (
  time_mark text,
  station text,
  name text,
  total integer,
  total_faulttime bigint,
  monday integer,
  tuesday integer,
  wednesday integer,
  thursday integer,
  friday integer,
  saturday integer,
  sunday integer,
  d_0 integer,
  d_1 integer,
  d_2 integer,
  d_3 integer,
  d_4 integer,
  d_5 integer,
  d_6 integer,
  d_7 integer,
  d_8 integer,
  d_9 integer,
  d_10 integer,
  d_11 integer,
  d_12 integer,
  d_13 integer,
  d_14 integer,
  d_15 integer,
  d_16 integer,
  d_17 integer,
  d_18 integer,
  d_19 integer,
  d_20 integer,
  d_21 integer,
  d_22 integer,
  d_23 integer,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(station, name))`, (err, result) => {
  if (err) { process.log.error(`Error: Create elevator_outages table: ${err}`) }
});

/**
 * The history table stores the history of all elevators.
 */
pool.query(`CREATE TABLE IF NOT EXISTS elevator_history (
  station text,
  name text,
  start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  end_time TIMESTAMP WITH TIME ZONE,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(station, name))`, (err, result) => {
  if (err) { process.log.error(`Error: Create elevator_history table: ${err}`) }
});

/**
 * The status table stores the current status of all elevators.
 * Get webpage data. Elevator missing in status table? Add it.
 * Get webpage data. Elevator is it gone? Remove it.
 */
pool.query(`CREATE TABLE IF NOT EXISTS elevator_status (
  station text,
  name text,
  status text,
  start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  PRIMARY KEY(station, name))`, (err, result) => {
  if (err) { process.log.error(`Error: Create elevator_status table: ${err}`) }
});

/* ------------------------------------ Delays ------------------------------------ */

/**
 * The delays table stores the delays of all products.
 * It stores avrage delay per weekday and per hour as well as the total number of departures and delays.
 * type stores if its too early or too late, so there will be 2 entries for each station, per line, per direction.
 */
pool.query(`CREATE TABLE IF NOT EXISTS delays (
  time_mark text,
  type text,
  station text,
  line text,
  direction integer,
  count_total integer,
  count_delayed integer,
  count_toearly integer,
  delay_mondays integer,
  delay_mondays_n integer,
  delay_tuesdays integer,
  delay_tuesdays_n integer,
  delay_wednesdays integer,
  delay_wednesdays_n integer,
  delay_thursdays integer,
  delay_thursdays_n integer,
  delay_fridays integer,
  delay_fridays_n integer,
  delay_saturdays integer,
  delay_saturdays_n integer,
  delay_sundays integer,
  delay_sundays_n integer,
  delay_0 integer,
  delay_0_n integer,
  delay_1 integer,
  delay_1_n integer,
  delay_2 integer,
  delay_2_n integer,
  delay_3 integer,
  delay_3_n integer,
  delay_4 integer,
  delay_4_n integer,
  delay_5 integer,
  delay_5_n integer,
  delay_6 integer,
  delay_6_n integer,
  delay_7 integer,
  delay_7_n integer,
  delay_8 integer,
  delay_8_n integer,
  delay_9 integer,
  delay_9_n integer,
  delay_10 integer,
  delay_10_n integer,
  delay_11 integer,
  delay_11_n integer,
  delay_12 integer,
  delay_12_n integer,
  delay_13 integer,
  delay_13_n integer,
  delay_14 integer,
  delay_14_n integer,
  delay_15 integer,
  delay_15_n integer,
  delay_16 integer,
  delay_16_n integer,
  delay_17 integer,
  delay_17_n integer,
  delay_18 integer,
  delay_18_n integer,
  delay_19 integer,
  delay_19_n integer,
  delay_20 integer,
  delay_20_n integer,
  delay_21 integer,
  delay_21_n integer,
  delay_22 integer,
  delay_22_n integer,
  delay_23 integer,
  delay_23_n integer,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(time_mark, station, line, direction))`, (err, result) => {
  if (err) { process.log.error(`Error: Create delays table: ${err}`) }
});

/**
 * The delays table stores the delays of all stations.
 */
pool.query(`CREATE TABLE IF NOT EXISTS delays_history (
  station text,
  line text,
  direction integer,
  delay integer,
  time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  PRIMARY KEY(station, line))`, (err, result) => {
  if (err) { process.log.error(`Error: Create delays_history table: ${err}`) }
});

/* ------------------------------------ Elevator ------------------------------------ */

/**
 * Insert new elevator into the status table on the first time the elevator is seen
 * @param {String} station 
 * @param {String} name 
 * @param {String} status 
 * @returns {Promise<[]>}
 */
const add_elevator_status = (station, name, status) => {
  return new Promise((resolve, reject) => {
    pool.query(`INSERT INTO elevator_status (station, name, status) VALUES ($1, $2, $3)`, [station, name, status], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Remove elevator from the status table when it is no longer seen
 * @param {String} station 
 * @param {Sting} name 
 * @returns {Promise<[]>}
 */
const remove_elevator_status = (station, name) => {
  return new Promise((resolve, reject) => {
    pool.query(`DELETE FROM elevator_status WHERE station = $1 AND name = $2`, [station, name], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Get all elevators from the status table
 * @returns {Promise<[]>}
 */
const get_elevator_status = () => {
  return new Promise((resolve, reject) => {
    pool.query(`SELECT * FROM elevator_status`, (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Add new elevator to the history table
 * @param {String} station 
 * @param {String} name 
 * @returns {Promise<[]>}
 */
const add_elevator_to_history = (station, name) => {
  return new Promise((resolve, reject) => {
    pool.query(`INSERT INTO elevator_history (station, name) VALUES ($1, $2)`, [station, name], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Update the end time of the elevator in the history table
 * @param {String} station 
 * @param {String} name 
 * @returns {Promise<[]>}
 */
const end_elevator_to_history = (station, name) => {
  return new Promise((resolve, reject) => {
    pool.query(`UPDATE elevator_history SET end_time = CURRENT_TIMESTAMP WHERE station = $1 AND name = $2`, [station, name], (err, result) => {
      if (err) { reject(err) }
      resolve(result)
    })
  })
}

/**
 * Every entry keeps track of the total number of outages and the number of outages per hour within a yearly quarter.
 * If the elevator isn´t in this table, it should be added.
 * If its here already, add the outage hours to the existing entry.
 * @param {String} time_mark
 * @param {String} station 
 * @param {String} name 
 * @param {Number} total 
 * @param {Object} outage_day
 * @param {Object} outage_hours 
 */
const add_elevator_outage = (time_mark, station, name, total, outage_day, outage_hours) => {
  return new Promise((resolve, reject) => {
    // add the outage_hours to the existing entry or create a new entry if its not here
    
  })
}

const elevator = {
  outage: {
    add: add_elevator_outage
  },
  history: {
    start: add_elevator_to_history,
    end: end_elevator_to_history
  },
  status: {
    add: add_elevator_status,
    remove: remove_elevator_status,
    getAll: get_elevator_status
  }
}

module.exports = {
  elevator: elevator
}