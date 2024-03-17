const convertBooltoProduct = (productBooleans) => {
    const productMap = {
      Produkt_Bus: 'Bus',
      Produkt_UBahn: 'UBahn',
      Produkt_Tram: 'Tram',
      Produkt_SBahn: 'SBahn',
      Produkt_RBahn: 'RBahn',
    };
  
    const productTypes = Object.keys(productBooleans).filter(key => productBooleans[key]).map(key => productMap[key]);
  
    return productTypes.join(', ');
  };

const formatDBHaltestellenToPULSFormat = (haltestellen) => {
    return haltestellen.map(haltestelle => {
        const productBooleans = {
            Produkt_Bus: haltestelle.produkt_bus,
            Produkt_UBahn: haltestelle.produkt_ubahn,
            Produkt_Tram: haltestelle.produkt_tram,
            Produkt_SBahn: haltestelle.produkt_sbahn,
            Produkt_RBahn: haltestelle.produkt_rbahn,
        };
        return {
            Haltestellenname: haltestelle.haltestellenname,
            VGNKennung: haltestelle.vgnkennung,
            VAGKennung: haltestelle.vagkennung.join(","),
            Latitude: haltestelle.latitude,
            Longitude: haltestelle.longitude,
            Produkte: convertBooltoProduct(productBooleans),
        }
    });
}

module.exports = {
    convertBooltoProduct,
    formatDBHaltestellenToPULSFormat,
};