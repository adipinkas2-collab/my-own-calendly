export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function slotsFor(date, settings, bookings, now = new Date()) {
  if (!settings.days.includes(date.getDay())) return [];
  const slots=[];
  for(let minute=settings.start*60;minute+settings.duration<=settings.end*60;minute+=settings.duration){
    const time=`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
    const at=new Date(`${dateKey(date)}T${time}:00`);
    if(at<=now) continue;
    if(bookings.some(b=>b.date===dateKey(date) && minute<b.minute+b.duration && minute+settings.duration>b.minute)) continue;
    slots.push({time,minute});
  }
  return slots;
}
