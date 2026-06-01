// ─────────────────────────────────────────────────────────────────────────────
// Klaviyo Debugger Feedback — Google Apps Script Web App
//
// SETUP (one time):
//  1. Go to https://script.google.com → New project
//  2. Paste this entire file, replacing any existing code
//  3. Click Deploy → New deployment → Type: Web app
//     - Execute as: Me
//     - Who has access: Anyone with Google account  (or "Anyone" for no auth)
//  4. Copy the Web app URL
//  5. Open sidepanel.js and paste it as the value of FEEDBACK_SCRIPT_URL
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_ID   = '1XMIZnx_cbPi5IlnA4-tm1LTGeQyV3vnovCo2gSmUrTA';
const SHEET_NAME = 'Sheet1';

function doPost(e) {
  try {
    const data  = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);

    sheet.appendRow([
      new Date().toLocaleString('en-GB'),   // Timestamp
      data.type        || '',               // Type
      data.subject     || '',               // Subject
      data.area        || '',               // Area
      data.description || '',               // Description
      data.reporter    || ''                // Reporter
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Health-check: visiting the URL in a browser should return OK
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'Klaviyo Debugger Feedback API — OK' }))
    .setMimeType(ContentService.MimeType.JSON);
}
