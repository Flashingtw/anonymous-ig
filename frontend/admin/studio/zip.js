// ZIP STORE: no compression dependency; immutable PNG bytes are already compressed.
export function crc32(bytes){
  let value=0xffffffff;
  for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}
  return (value^0xffffffff)>>>0;
}
export function makeZip(files){
  const enc=new TextEncoder(),parts=[],central=[];let offset=0;
  for(const [name,data] of files){
    const filename=enc.encode(name),bytes=data instanceof Uint8Array?data:enc.encode(data),crc=crc32(bytes);
    const local=new Uint8Array(30+filename.length),v=new DataView(local.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);
    v.setUint32(14,crc,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,filename.length,true);local.set(filename,30);
    const entry=new Uint8Array(46+filename.length),c=new DataView(entry.buffer);
    c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);
    c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,filename.length,true);c.setUint32(42,offset,true);entry.set(filename,46);
    parts.push(local,bytes);central.push(entry);offset+=local.length+bytes.length;
  }
  const end=new Uint8Array(22),e=new DataView(end.buffer),centralSize=central.reduce((n,b)=>n+b.length,0);
  e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}
