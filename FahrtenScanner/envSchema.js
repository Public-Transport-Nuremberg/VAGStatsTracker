module.exports = {
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
    "PRODUCTS": {
        "section": "GENERAL",
        "type": "string",
        "validation": "required||custom_list:ubahn,bus,tram",
        "default": "ubahn,bus,tram"
    },
}