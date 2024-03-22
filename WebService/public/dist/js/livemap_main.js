const map = new ol.Map({
	target: "map",
	layers: [
		new ol.layer.Tile({
			source: new ol.source.OSM(),
		}),
	],
	view: new ol.View({
		center: ol.proj.fromLonLat([11.0787063802325, 49.4633775635804]),
		zoom: 13,
	}),
});

const vectorSource = new ol.source.Vector({
	features: [], // We will add features here
});

function propertiesToColor(item) {
	switch (item.Produkt) {
		case "UBahn":
			return item.Linienname === "U1"
				? "blue"
				: item.Linienname === "U2"
					? "red"
					: "green";
		case "Tram":
			return "purple";
		case "Bus":
			return "red";
		default:
			return "black"; // Default color
	}
}

const refreshLiveMap = () => {
	const queryString = window.location.search;

	fetch(`/api/v1/live/map${queryString}`)
		.then((response) => response.json())
		.then((data) => {
			vectorSource.clear();

			Object.keys(data).forEach((key) => {
				const item = data[key];
				let color = propertiesToColor(item);

				const marker = new ol.Feature({
					geometry: new ol.geom.Point(
						ol.proj.fromLonLat([item.Longitude, item.Latitude])
					),
					VGNKennung: item.VGNKennung,
					VAGKennung: item.VAGKennung,
					Produkt: item.Produkt,
					Linienname: item.Linienname,
					Richtung: item.Richtung,
					Richtungstext: item.Richtungstext,
					Fahrzeugnummer: item.Fahrzeugnummer,
					Betriebstag: item.Betriebstag,
					Besetzgrad: item.Besetzgrad,
					Haltepunkt: item.Haltepunkt,
					Haltestellenname: item.Haltestellenname,
					Produkte: item.Produkte,
					color: color,
				});

				vectorSource.addFeature(marker);
			});
		});
};

// Create a cluster source with the vector source
const clusterSource = new ol.source.Cluster({
	distance: 5, // Cluster distance in pixels. Adjust as needed.
	source: vectorSource, // The source with individual features
});

// Create a vector layer using the cluster source
const clusterLayer = new ol.layer.Vector({
	source: clusterSource,
	style: function (feature) {
		const features = feature.get("features");
		let color = features[0].get("color");
		const allSameColor = features.every((f) => f.get("color") === color);

		const size = features.length;

		// If there's no feature (shouldn't happen in normal circumstances), return a default style
		if (size === 0) {
			return new ol.style.Style({
				// Define a default style
			});
		}

		if (!allSameColor) {
			color = "black"; // Set to black if there are multiple colors
		}

		return new ol.style.Style({
			image: new ol.style.RegularShape({
				fill: new ol.style.Fill({ color: color }),
				stroke: new ol.style.Stroke({ color: color, width: 1 }),
				points: 8,
				radius: 8,
				angle: Math.PI / 4,
			}),
			text: new ol.style.Text({
				text: size.toString(),
				fill: new ol.style.Fill({ color: "#fff" }), // White text color
				stroke: new ol.style.Stroke({ color: "#000", width: 1 }), // Black text outline for readability
				font: "bold 11px sans-serif",
			}),
		});
	},
});

const popup = document.getElementById("popup");
const popupContent = document.getElementById("popup-content");

const overlay = new ol.Overlay({
	element: popup,
	positioning: "bottom-center",
	stopEvent: false,
	offset: [0, 0],
});

// Add the cluster layer to the map
map.addLayer(clusterLayer);
map.addOverlay(overlay);

map.on("singleclick", function (event) {
	map.forEachFeatureAtPixel(event.pixel, function (feature, layer) {
		const clusterPoints = feature.get("features");

		if (clusterPoints.length > 1) {
			// Smaler Cluster, Show multiple Pics
			const features = feature.get("features");
			const properties = features.map(function (feature) {
				return feature.getProperties();
			});
			console.log(properties);

			popupContent.innerHTML = `<div class="lm-content">
                <h2>Fahrzeuge</h2>
                ${properties
					.map(function (property) {
						return `
                        <p><span>Linie</span>: <span style="color:${propertiesToColor(property)}">${property.Linienname}</span></p>
                        <p><span>Richtung</span>: ${property.Richtungstext}</p>
                        <p><span>Haltepunkt</span>: ${property.Haltepunkt}</p>
                        <p><span>Haltestelle</span>: ${property.Haltestellenname}</p>
                    `;
					})
					.join("<div class='lm-split'></div>")}
                </div>
            `;

			// popupContent.innerHTML = '<strong>Fahrzeuge</strong><br/>' +

			//     // Add the properties of all features in the cluster use 1 row per feature
			//     properties.map(function (properties) {
			//         return `Linie: ${properties.Linienname} | Richtung: ${properties.Richtungstext} | Fahrzeugnummer: ${properties.Fahrzeugnummer} | Betriebstag: ${properties.Betriebstag} | Besetzgrad: ${properties.Besetzgrad} | Haltepunkt: ${properties.Haltepunkt} | Haltestelle: ${properties.Haltestellenname}`;
			//     }).join('<br/>');

			overlay.setPosition(
				clusterPoints[0].getProperties().geometry.flatCoordinates
			); // set position absolute to coords
			popup.style.display = "block";
		} else {
			const feature = clusterPoints[0];
			const properties = feature.getProperties();
			console.log(properties);

			popupContent.innerHTML = `<div class="lm-content">
                <h2>Fahrzeug</h2>
                <p><span>Linie</span>: <span style="color:${propertiesToColor(properties)}">${properties.Linienname}</span></p>
                <p><span>Richtung</span>: ${properties.Richtungstext}</p>
                <p><span>Fahrzeugnummer</span>: ${properties.Fahrzeugnummer}</p>
                <p><span>Betriebstag</span>: ${properties.Betriebstag}</p>
                <p><span>Besetzgrad</span>: ${properties.Besetzgrad}</p>
                <p><span>Haltepunkt</span>: ${properties.Haltepunkt}</p>
                <p><span>Haltestelle</span>: ${properties.Haltestellenname}</p>
            </div>`;
			overlay.setPosition(properties.geometry.flatCoordinates); // set position absolute to coords
			popup.style.display = "block";
		}
	});
});

// Hide the popup when the map is moved
map.on("movestart", function () {
	popup.style.display = "none";
});

// Create a vector layer using the cluster source
const vectorLayer = new ol.layer.Vector({
	source: vectorSource,
});

setInterval(refreshLiveMap, 1000);
