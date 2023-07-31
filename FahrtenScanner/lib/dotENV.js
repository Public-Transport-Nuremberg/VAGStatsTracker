const validate = require('@lib/validateJoi');

// Check all .env values if they are valid

const checkEnv = (envSchema) => {
    let failed = false;

    const envKeys = Object.keys(envSchema);

    envKeys.forEach(key => {
        const value = process.env[key];

        const validation = validate.validateWithJoi(value, {
            key,
            type: envSchema[key].type,
            lable: key,
            validation: envSchema[key].validation
        });

        if (validation) {
            console.log(value)
            console.log(`Invalid value for ${key}: ${value}`);
            console.log(validation.details.message);
            failed = true;
        }
    })

    return failed || false;
}

module.exports = {
    checkEnv
}