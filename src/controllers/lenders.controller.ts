import { Handler } from "../types/handler";

export const getLenders: Handler = async (_req, res) => {
  res.json({ success: true, data: [] });
};

export const getLenderById: Handler = async (_req, res) => {
  res.json({ success: true });
};

export const createLender: Handler = async (_req, res) => {
  res.json({ success: true });
};

export const updateLender: Handler = async (_req, res) => {
  res.json({ success: true });
};

export const getLenderWithProducts: Handler = async (_req, res) => {
  res.json({ success: true });
};
