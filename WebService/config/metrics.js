module.exports = {
    "Metric": {
        "TotalTripsTracked.UBahn": {
            "Metric": "TotalTripsTracked_UBahn",
            "Type": "gauge",
            "Help": "The total number of UBahn trips currently tracked",
        },
        "TotalTripsTracked.Bus": {
            "Metric": "TotalTripsTracked_Bus",
            "Type": "gauge",
            "Help": "The total number of Bus trips currently tracked",
        },
        "TotalTripsTracked.Tram": {
            "Metric": "TotalTripsTracked_Tram",
            "Type": "gauge",
            "Help": "The total number of Tram trips currently tracked",
        },
        "TotalTripsActive.UBahn": {
            "Metric": "TotalTripsActive_UBahn",
            "Type": "gauge",
            "Help": "The total number of UBahn trips currently active",
        },
        "TotalTripsActive.Bus": {
            "Metric": "TotalTripsActive_Bus",
            "Type": "gauge",
            "Help": "The total number of Bus trips currently active",
        },
        "TotalTripsActive.Tram": {
            "Metric": "TotalTripsActive_Tram",
            "Type": "gauge",
            "Help": "The total number of Tram trips currently active",
        }
    },
    "MetricList": {
        "Trips.RequestTime": {
            "rate": {
                "Metric": "TripsRequestTimeRate",
                "Type": "gauge",
                "Help": "The rate of requests per second",
            },
            "averageResponseTime": {
                "Metric": "TripsRequestTimeAverage",
                "Type": "gauge",
                "Help": "The average response time of requests",
            }
        },
        "Trip.RequestTime": {
            "rate": {
                "Metric": "TripRequestTimeRate",
                "Type": "gauge",
                "Help": "The rate of requests per second",
            },
            "averageResponseTime": {
                "Metric": "TripRequestTimeAverage",
                "Type": "gauge",
                "Help": "The average response time of requests",
            }
        },
    },
    "ErrorList": {
        "Trips.Statuscode": {
            "ENOTFOUND": {
                "Metric": "TripsStatuscode_ENOTFOUND",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNREFUSED": {
                "Metric": "TripsStatuscode_ECONNREFUSED",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ETIMEDOUT": {
                "Metric": "TripsStatuscode_ETIMEDOUT",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNRESET": {
                "Metric": "TripsStatuscode_ECONNRESET",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "EAI_AGAIN": {
                "Metric": "TripsStatuscode_EAI_AGAIN",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            }
        },
        "Trip.Statuscode": {
            "ENOTFOUND": {
                "Metric": "TripStatuscode_ENOTFOUND",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNREFUSED": {
                "Metric": "TripStatuscode_ECONNREFUSED",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ETIMEDOUT": {
                "Metric": "TripStatuscode_ETIMEDOUT",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNRESET": {
                "Metric": "TripStatuscode_ECONNRESET",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "EAI_AGAIN": {
                "Metric": "TripStatuscode_EAI_AGAIN",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            }
        },
    },
    "RedisInfo": {
        "Clients": {
            "connected_clients": {
                "Metric": "ConnectedClients",
                "Type": "gauge",
                "Help": "The amount of connected clients",
            },
            "blocked_clients": {
                "Metric": "BlockedClients",
                "Type": "gauge",
                "Help": "The amount of blocked clients",
            }
        },
        "Memory": {
            "used_memory": {
                "Metric": "UsedMemory",
                "Type": "gauge",
                "Help": "The amount of used memory",
            },
            "used_memory_peak": {
                "Metric": "UsedMemoryPeak",
                "Type": "gauge",
                "Help": "The peak amount of used memory",
            },
            "used_memory_rss": {
                "Metric": "UsedMemoryRSS",
                "Type": "gauge",
                "Help": "The amount of used memory RSS",
            }
        },
        "Stats": {
            "instantaneous_ops_per_sec": {
                "Metric": "InstantaneousOpsPerSec",
                "Type": "gauge",
                "Help": "The amount of instantaneous ops per second",
            },
            "total_commands_processed": {
                "Metric": "TotalCommandsProcessed",
                "Type": "gauge",
                "Help": "The amount of total commands processed",
            },
            "keyspace_hits": {
                "Metric": "KeyspaceHits",
                "Type": "gauge",
                "Help": "The amount of keyspace hits",
            },
            "keyspace_misses": {
                "Metric": "KeyspaceMisses",
                "Type": "gauge",
                "Help": "The amount of keyspace misses",
            },
            "rejected_connections": {
                "Metric": "RejectedConnections",
                "Type": "gauge",
                "Help": "The amount of rejected connections",
            },
            "expired_keys": {
                "Metric": "ExpiredKeys",
                "Type": "gauge",
                "Help": "The amount of expired keys",
            },
            "evicted_keys": {
                "Metric": "EvictedKeys",
                "Type": "gauge",
                "Help": "The amount of evicted keys",
            },
        },
        "Cpu": {
            "used_cpu_sys": {
                "Metric": "UsedCpuSys",
                "Type": "gauge",
                "Help": "The amount of used CPU sys",
            },
            "used_cpu_user": {
                "Metric": "UsedCpuUser",
                "Type": "gauge",
                "Help": "The amount of used CPU user",
            }
        }
    }
}