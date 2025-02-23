/**
 * Converts a product string to a integer
 * @param {String} product 
 * @returns {Number}
 */
const convertProductToInt = (product) => {
    switch (product) {
        case 'Bus':
            return 1;
        case 'UBahn':
            return 2;
        case 'Tram':
            return 3;
        case 'SBahn':
            return 4;
        case 'RBahn':
            return 5;
        default:
            return 0;
    }
}

/**
 * Converts an integer back to a product string
 * @param {Number} productInt
 * @returns {String}
 */
const convertIntToProduct = (productInt) => {
    switch (productInt) {
        case 1:
            return 'Bus';
        case 2:
            return 'UBahn';
        case 3:
            return 'Tram';
        case 4:
            return 'SBahn';
        case 5:
            return 'RBahn';
        default:
            return 'Unknown';
    }
}

/**
 * Converts a besetzungsgrad string to a integer
 * @param {String} besetzungsgrad 
 * @returns {Number}
 */
const convertBesezungsgradToInt = (besetzungsgrad) => {
    switch (besetzungsgrad) {
        case 'Unbekannt':
            return 1;
        case 'Schwachbesetzt':
            return 2;
        case 'Starkbesetzt':
            return 3;
        case 'Ueberfuellt':
            return 4;
        default:
            process.log.warn('Unknown Besetzungsgrad:', besetzungsgrad);
            return 0;
    }
}

/**
 * Converts an integer back to a besetzungsgrad string
 * @param {Number} besetzungsgradInt
 * @returns {String}
 */
const convertIntToBesetzungsgrad = (besetzungsgradInt) => {
    switch (besetzungsgradInt) {
        case 1:
            return 'Unbekannt';
        case 2:
            return 'Schwachbesetzt';
        case 3:
            return 'Starkbesetzt';
        case 4:
            return 'Ueberfuellt';
        default:
            process.log.warn('Unknown Besetzungsgrad integer:', besetzungsgradInt);
            return 'Unknown';
    }
}