# VAG Stats Tracker
[Install](#Install)
## Goal
### Features
ToDo:
- [ ] Track delays of everything
    - [ ] Bus
    - [ ] U-Bahn
    - [ ] Tram
- [ ] Link common delay causes to the average delay they cause
- [ ] Track Elevator malfunctions and duration
- [ ] Smart warnings of potential delays
- [ ] Smarter departure lookup tool
- [ ] Smarter connection lookup tool
- [ ] Something like Flightradar24s "People on my plane"
- [ ] Live Map of ALL services
- [ ] Easy way to report delays or other stuff (Not directly to the company)
- [ ] Smart alexa alarmclock (Alexa, wake me up so i´ll be in scool by 8 o´clock)
- [ ] New API Methods to extend the VAG PULS API (If i figure out how to install PGSQL Plugins, lol)
- [ ] More...
### Project
Unlike my other projects this project will be built around my learning curve to cloud like software architecture.  
Target Hardware:
- 4 Nodes each with:
- 8x ARMv8 SoC 
- 16 GB DDR4
- 1 TB NVME
- 1 Gbit/s LAN

## Install
### Debain/Ubuntu
Run `node install`
### Why not docker compose?
Because its not supposed to run with docker. Kubernetes is the way to go.