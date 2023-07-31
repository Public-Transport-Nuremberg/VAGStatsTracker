module.exports = {
    "LOG_LEVEL": {
        "type": "number",
        "validation": "min:0,max:4"
    },
    "APPLICATION": {
        "type": "string",
        "validation": "min:1,max:32"
    },
    "PRODUCTS": {
        "type": "string",
        "validation": "required,min:1,max:32"
    },
}