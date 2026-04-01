const fs = require('fs');
const path = require('path');

module.exports = async (page, scenario) => {
  const cookiePath = scenario.cookiePath;
  if (cookiePath) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiePath));
      for (const cookie of cookies) {
        await page.setCookie(cookie);
      }
    } catch (e) {}
  }
};
