import type { Request, Response } from "express";
import { validationResult } from "express-validator";
import * as userService from "../services/user.service";

function handleValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }

  return true;
}

export async function createUser(req: Request, res: Response) {
  if (!handleValidation(req, res)) return;

  const user = await userService.create(req.body);
  return res.status(201).json(user);
}

export async function getUser(req: Request, res: Response) {
  const user = await userService.findById(String(req.params.id));

  if (!user) {
    return res.sendStatus(404);
  }

  return res.status(200).json(user);
}

export async function updateUser(req: Request, res: Response) {
  if (!handleValidation(req, res)) return;

  const user = await userService.update(String(req.params.id), req.body);

  if (!user) {
    return res.sendStatus(404);
  }

  return res.status(200).json(user);
}

export async function deleteUser(req: Request, res: Response) {
  const deleted = await userService.remove(String(req.params.id));

  if (!deleted) {
    return res.sendStatus(404);
  }

  return res.sendStatus(204);
}
