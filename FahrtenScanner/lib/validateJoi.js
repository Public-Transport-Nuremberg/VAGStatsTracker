const Joi = require('joi');

/**
 * create a function that validates a value using a pipe seperated list of validation rules with joi
 * like 'required,max:255,min:3' or 'required,regex:^[a-zA-Z0-9]{3,30}$'
 * 
 * Returns null if the value is valid, otherwise returns an error object
 * @param {String} newValue 
 * @param {Object} valueObject 
 * @returns {Error|null}
 */
const validateWithJoi = (newValue, valueObject) => {
    const {key, type, lable, validation} = valueObject;

    if(!validation) return null;

    const schema = Joi.object({
        [key]: createValidationRule(validation, type)
    });

    // validate the value
    const {error} = schema.validate({[key]: newValue});

    return error || null;
}

/**
 * Create a Joi validation rule from a pipe seperated list of validation rules
 * @param {String} validation 
 * @param {String} type 
 * @returns 
 */
const createValidationRule = (validation, type) => {
    let settingsValidation = Joi[type]();

    // split the validation rules by pipe
    const validationRules = validation.split('||');

    // loop through the rules and add them to the validation
    validationRules.forEach(rule => {
        const [ruleName, ruleValue] = rule.split(':');

        // If there are custom rules, we add them here

        // custom_list can validate the input against a list of valid values, unlike valid() which only accepts one value
        if (ruleName === 'custom_list') {
            const validParts = ruleValue.split(',');
            settingsValidation = settingsValidation.custom((value, helper) => {
                const parts = value.split(',');
                const invalidParts = parts.filter(part => !validParts.includes(part));
                if (invalidParts.length > 0) {
                    return helper.message(`Invalid Element(s): ${invalidParts.join(', ')}. Allowed: ${validParts.join(', ')}`);
                }
                return value;  // Alles gut, Rückgabe des validen Wertes
            }, 'Komma-seperated list');
            return;
        }

        // if no rule value is given, just call the rule
        if (!ruleValue) {
            settingsValidation = settingsValidation[ruleName]();
            return;
        }

        // parse rule parameter to int inf its a numner, to boolean if its a boolean, to regex if its a regex
        let parsedRuleValue = ruleValue;
        if (!isNaN(ruleValue)) parsedRuleValue = parseInt(ruleValue)
        if (ruleValue === 'true') parsedRuleValue = true;
        if (ruleValue === 'false') parsedRuleValue = false;
        if (ruleValue.match(/^\/.+\/$/)) parsedRuleValue = new RegExp(ruleValue.replace(/^\/|\/$/g, ''));

        settingsValidation = settingsValidation[ruleName](parsedRuleValue);
    })

    return settingsValidation;
}

module.exports = {
    validateWithJoi
}