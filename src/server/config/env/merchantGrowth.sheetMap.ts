export type GoogleSheetsPayload = {
  application: { id: string };
  [key: string]: unknown;
};

export type GoogleSheetsColumn = {
  header: string;
  value: (payload: GoogleSheetsPayload) => string | number | null;
};

export type GoogleSheetsSheetMap = {
  applicationIdHeader: string;
  columns: GoogleSheetsColumn[];
};

export const sheetMap: GoogleSheetsSheetMap = {
  applicationIdHeader: "Application ID",
  columns: [
    {
      header: "Application ID",
      value: (payload) => payload.application.id,
    },
  ],
};
