import { twilio } from "./twilioClient";

export async function createConference(name: string) {

  return twilio.conferences.create({
    friendlyName: name
  });

}

export async function addParticipant(
  conferenceName: string,
  to: string,
  from: string
) {

  return twilio.conferences(conferenceName)
    .participants
    .create({
      to,
      from
    });

}

export async function removeParticipant(
  conferenceSid: string,
  callSid: string
) {

  return twilio.conferences(conferenceSid)
    .participants(callSid)
    .remove();

}
