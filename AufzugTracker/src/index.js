const vgn_wrapper = require('oepnv-nuremberg');

const vgn = new vgn_wrapper.openvgn();

vgn.getVagWebpageDisturbances().then((web_data) => {
    console.log(web_data);
});