/** Serialize each track's metadata writes without blocking unrelated tracks. */
export function createTrackQueue() {
  const pending=new Map();
  return {run(id,task){
    const previous=pending.get(id)||Promise.resolve();
    const next=previous.catch(()=>{}).then(task);
    pending.set(id,next);
    next.then(()=>{if(pending.get(id)===next)pending.delete(id);},()=>{if(pending.get(id)===next)pending.delete(id);});
    return next;
  }};
}
