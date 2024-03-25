# VAG Stats Tracker
[Install](#Install)
## Goal
### Features
ToDo:
- [X] Track delays of everything
    - [X] Bus
    - [X] U-Bahn
    - [X] Tram
- [X] Live Map of ALL services (Experimental)
- [ ] Generate Heatmaps of delays
- [ ] Easy way to report delays or other stuff (Not directly to the company)

Things i´d like to do but got not enough time for:  
- [ ] Smart warnings of potential delays
- [ ] Link common delay causes to the average delay they cause
- [ ] Track Elevator malfunctions and duration
- [ ] Smarter departure lookup endpoint
- [ ] Smarter connection lookup endpoint
- [ ] Something like Flightradar24s "People on my plane"
- [ ] Smart alexa alarmclock (Alexa, wake me up so i´ll be in scool by 8 o´clock)
- [ ] New API Methods to extend the VAG PULS API (If i figure out how to install PGSQL Plugins, lol)
- [ ] More...
      
### Project (The kickstarted still didn´t deliver :/)
Unlike my other projects this project will be built around my learning curve to cloud like software architecture.  
Target Hardware:
- 4 Nodes each with:
- 8x ARMv8 SoC 
- 16 GB DDR4
- 1 TB NVME
- 1 Gbit/s LAN

## Install
### Windows
#### Requirements:
- Docker Desktop
- NodeJs 20
- PGAdmin (or other PG Interface)
- Some IDE
- Redis Insight (Optional)
#### Steps:
1. Create containers with `docker compose up -d` in some powershell window in the root of the repo.
2. Use SQL Tool (PGAdmin) to generate a DB. Default user `admin` and password `adminpassword`
3. You need to make a .env [Can be fond below](#EnvSetup) File in all programs you wanna use:
    - FahrtenProcessor (Tracks a ongoing trip)
    - FahrtenScanner (Finds new trips)
    - WebService (Provides /metrics endpoint and all API routes)
4. Run programs in order, start al programs from their root:
    - Go into /WebService and run `node index.js` wait till it its ready
    - Go into /FahrtenScanner and run `node index.js` (If you already had it running run `node /tools/clearRedis.js` to wipe the cache)
    - Go into /FahrtenProcessor and run `node index.js`
5. You know its working when Scanner shows a lot of things realy fast, and Processor starts picking up all the jobs over the next couple of seconds

## EnvSetup
### WebService
```env

# Application
APPLICATION=WebService
DOMAIN=http://localhost
FALLBACKLANG=de

# Logging
LOG_LEVEL=4# 0 = error, 1 = warning, 2 = info, 3 = debug, 4 = system
LOG_TYPE=console# console or stdout
LOG_COLOR=true# true or false
LOG_TEMPLATE=# leave empty for default or enter a custom template
LOG_STACK=false
SENTRY_DSN=#Optional

# Database PG
DB_HOST="localhost"
DB_PORT=5432
DB_NAME="<Your Generated DB Name"
DB_USER="admin"
DB_PASSWORD="adminpassword"

# Database Redis (Cache)
REDIS_USER="default"
REDIS_PASSWORD="example"
REDIS_HOST="localhost"
REDIS_PORT=6379
REDIS_DB=0

# Webserver
GLOBALWAITTIME=0 # Delay in ms until /src is loaded
EXTRAERRORWEBDELAY=0
PORT=80 # Port for webserver

# Security
# HashSalts can be modifyed any time but will not apply to existing hashes... also keep in mind 0 will disable the hash, then all hashed IPs will not work because its switches to direct IP comparison
SALTROUNDS=12 # Salt rounds for password hashing
WEBTOKENLENGTH=64 # Length of the Web Token
WebTokenDurationH=96 # How long the Web Token is valid for in hours
Web2FAValidForMin=5 # How long the 2FA token is valid for in minutes

# Limiter
DECREASEPERMIN=120 # Used for Limiter

# Proxy Settings
# This can be exploited if your proxy does not overwrite the headers
# It will also display a warning if proxyed requests are comming in but are not enabled here
CLOUDFLARE_PROXY=false
ANY_PROXY=false

# Cache Settings
CACHEDRIVER=local # Can also be redis

# HyperExpress Settings (Webserver)
HE_FAST_BUFFERS=false # If true, will use allocUnsafe
```

### FahrtenScanner & FahrtenProcessor
```env
APPLICATION=FahrtenScanner #or FahrtenProcessor

# LOGGING
LOG_LEVEL=4
LOG_TYPE=console# console or stdout
LOG_COLOR=true# true or false
LOG_TEMPLATE=# leave empty for default or enter a custom template
SENTRY_DDSN=

# GENERAL
PRODUCTS=UBahn,Bus,Tram # Things you wanna track
WATCHDOG_TIMEOUT=60

# Database PG
DB_HOST="localhost"
DB_PORT=5432
DB_NAME="<Your Generated DB Name"
DB_USER="admin"
DB_PASSWORD="adminpassword"

# Database Redis (Cache)
REDIS_USER="default"
REDIS_PASSWORD="example"
REDIS_HOST="localhost"
REDIS_PORT=6379
REDIS_DB=0

SCANBEFORE=30 # Scan before x seconds
SCAN_INTERVAL=5 # Scan every x seconds
ERROR_EXPIRE=600 # Expire errors after X seconds
```
