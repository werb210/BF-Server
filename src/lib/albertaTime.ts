// BF_SERVER_ALBERTA_TIME_v743
// Alberta stopped changing its clocks in 2026 and is on UTC-6 all year (Official Time Act; IANA tzdata
// 2026c). Servers, browsers and phones with older time-zone data still treat the Edmonton zone as falling
// back to UTC-7 on 2026-11-01, which would put winter bookings, meeting texts and send windows an hour off.
// America/Regina has been UTC-6 all year in every version of the data, so it gives correct Alberta time
// everywhere from 2026-03-08 onward. (Winter dates before that were UTC-7 and would read an hour later.)
export const ALBERTA_TZ = "America/Regina";
