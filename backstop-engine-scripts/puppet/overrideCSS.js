module.exports = async (page, scenario) => {
  if (scenario.overrideCSS) {
    await page.addStyleTag({ content: scenario.overrideCSS });
  }
};
