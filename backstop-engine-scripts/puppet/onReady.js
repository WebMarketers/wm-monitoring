module.exports = async (page, scenario, vp) => {
  await require('./clickAndHoverHelper')(page, scenario);
  await require('./overrideCSS')(page, scenario);
};
