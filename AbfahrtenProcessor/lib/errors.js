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

class NotDeparturesFound extends CustomError {
    /**
     * No departures found error
     * @param {String} message | Message to display
     */
    constructor(message) {
        super(message);

        this.info = 'The Trip ID was not found in the departures list.';
    }
}

module.exports = {
    NotDeparturesFound
}