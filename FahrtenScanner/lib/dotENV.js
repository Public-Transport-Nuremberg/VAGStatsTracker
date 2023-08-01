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
            process.log.error(`Invalid value for ${key}: ${validation.details[0].message}`);
            failed = true;
        }
    })

    return failed || false;
}

module.exports = {
    checkEnv
}