import { Request, Response } from 'express';

export const getLenderRequirements = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({
      success: true,
      data: []
    });
  } catch (err) {
    console.error('REQ ERROR', err);
    return res.status(500).json({ success: false });
  }
};

// compatibility export
export const listLenderProductRequirementsHandler = getLenderRequirements;
