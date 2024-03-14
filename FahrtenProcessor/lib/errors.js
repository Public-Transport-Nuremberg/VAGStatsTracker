/**
 * Custom Error Class
 */
class CustomError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        this.info = null;
    }

    /**
     * Set the info of the error
     * @param {String} info 
     * @returns 
     */
    withInfo(info) {
        this.info = info;
        return this; // Allow chaining
    }
}

module.exports = {
    NotDeparturesFound
}