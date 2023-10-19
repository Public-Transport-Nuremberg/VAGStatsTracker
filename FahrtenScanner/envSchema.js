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
    "PRODUCTS": {
        "section": "GENERAL",
        "type": "string",
        "validation": "required||custom_list:ubahn,bus,tram",
        "default": "ubahn,bus,tram"
    },
}