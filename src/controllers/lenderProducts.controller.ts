import { Request, Response } from 'express';

export const getLenderProducts = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({
      success: true,
      data: []
    });
  } catch (err) {
    console.error('PRODUCTS ERROR', err);
    return res.status(500).json({ success: false });
  }
};
