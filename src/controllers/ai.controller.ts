import { Request, Response } from 'express';

export const aiHandler = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({
      success: true,
      message: 'AI endpoint alive',
      data: null
    });
  } catch (err) {
    console.error('AI ERROR', err);
    return res.status(500).json({ success: false });
  }
};
