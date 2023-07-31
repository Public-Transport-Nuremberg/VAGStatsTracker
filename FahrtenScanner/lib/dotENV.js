const validate = require('@lib/validateJoi');

// Check all .env values if they are valid

const checkEnv = () => {
    const env = process.env;
    let failed = false;

    const envKeys = Object.keys(env);

    envKeys.forEach(key => {
        const value = env[key];

        const validation = validate.validateWithJoi(value, {
            key,
            type: 'string',
            lable: key,
            validation: process.app.envSchema[key]
        });

        if (validation) {
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