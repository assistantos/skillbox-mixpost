import mitt from 'mitt';
const emitter = mitt();
// Expose emitter globally for Skillbox Assistant Bridge
window.__mixpostEmitter = emitter;
export default emitter;
