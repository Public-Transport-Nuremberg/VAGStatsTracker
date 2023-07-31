const Joi = require('joi');

// create a function that validates a value using a pipe seperated list of validation rules with joi
// like 'required,max:255,min:3' or 'required,regex:^[a-zA-Z0-9]{3,30}$'
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

const createValidationRule = (validation, type) => {
    let settingsValidation = Joi[type]();

    // split the validation rules by pipe
    const validationRules = validation.split('|');

    // loop through the rules and add them to the validation
    validationRules.forEach(rule => {
        const [ruleName, ruleValue] = rule.split(':');

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

        console.log(parsedRuleValue)

        settingsValidation = settingsValidation[ruleName](parsedRuleValue);
    })

    return settingsValidation;
}

module.exports = {
    validateWithJoi
}

//Test

const output = validateWithJoi('ter', {
    key: 'test',
    type: 'string',
    lable: 'test',
    validation: 'required|min:2|max:32|regex:/h(e|a)llo/gi'
})

console.log(output)