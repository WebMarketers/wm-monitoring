module.exports = async (page, scenario) => {
  if (scenario.hoverSelector) {
    await page.hover(scenario.hoverSelector);
  }
  if (scenario.clickSelector) {
    await page.click(scenario.clickSelector);
  }
  if (scenario.postInteractionWait) {
    await page.waitForTimeout(scenario.postInteractionWait);
  }
};
