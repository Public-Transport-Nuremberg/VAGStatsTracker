module.exports = {
    "APPLICATION": {
        "section": "Application",
        "type": "string",
        "validation": "min:1||max:32",
        "default": "FahrtenScanner"
    },
    "LOG_LEVEL": {
        "section": "LOGGING",
        "type": "number",
        "validation": "min:0||max:4",
        "default": 1
    },
    "APPLICATION": {
        "type": "string",
        "validation": "min:1||max:32",
        "default": "FahrtenScanner"
    },
    "LOG_TYPE": {
        "type": "string",
        "validation": "required||custom_list:console,stdout",
        "default": "console",
        "discription": "console or stdout"
    },
    "LOG_COLOR": {
        "type": "string",
        "validation": "required||custom_list:true,false",
        "default": "true",
        "discription": "true or false"
    },
    "LOG_TEMPLATE": {
        "type": "string",
        "validation": "min:0||max:255",
        "default": "",
        "discription": "leave empty for default or enter a custom template"
    },
    "WATCHDOG_TIMEOUT": {
        "type": "number",
        "validation": "min:1||max:600",
        "default": 60
    },
    "DB_HOST": {
        "section": "DATABASE PG",
        "type": "string",
        "validation": "required",
        "default": "127.0.0.1"
    },
    "DB_PORT": {
        "type": "number",
        "validation": "required",
        "default": 6969
    },
    "DB_USER": {
        "type": "string",
        "validation": "required",
        "default": "postgres"
    },
    "DB_PASSWORD": {
        "type": "string",
        "validation": "required",
        "default": "postgres"
    },
    "REDIS_USER": {
        "section": " DATABASEREDIS (Cache)",
        "type": "string",
        "validation": "required",
        "default": "default"
    },
    "REDIS_PASSWORD": {
        "type": "string",
        "validation": "required",
        "default": "adminpassword"
    },
    "REDIS_HOST": {
        "type": "string",
        "validation": "required",
        "default": "127.0.0.1"
    },
    "REDIS_PORT": {
        "type": "number",
        "validation": "required",
        "default": 6379
    },
    "REDIS_DB": {
        "type": "number",
        "validation": "required",
        "default": 0
    }
}