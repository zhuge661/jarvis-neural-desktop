/* Clustered neural volume; public API retained from the MIT quantum-neural-ar integration. */
(function () {
  'use strict';
  window.NeuralCore = function (parent) {
    const group=new THREE.Group(); group.name='clustered-neural-core'; parent.add(group);
    let meshes=[], formation=0, density=1, backdrop=false, clock=0, lastTime=0, visibility=1, pulseIndex=0;
    const uniforms={time:{value:0},visibility:{value:1},activity:{value:0},pulseTimes:{value:[-100,-100,-100]},hand:{value:new THREE.Vector3(100,100,100)},handOn:{value:0}};
    const common=`uniform float time,visibility,activity; uniform float pulseTimes[3]; uniform vec3 hand; uniform float handOn;
      float impulse(vec3 p){float v=0.;for(int i=0;i<3;i++){float age=time-pulseTimes[i];
        v+=(1.-smoothstep(0.,.20,abs(length(p)-age*1.1)))*(1.-smoothstep(0.,2.2,age))*step(0.,age);}
        return min(1.,v+handOn*(1.-smoothstep(0.,.6,distance(p,hand)))*.45);}
      float signal(float d){float phase=fract(time*.30-d*.37);return pow(max(0.,1.-phase/.22),3.);}`;
    function build(){
      for(const mesh of meshes){group.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();} meshes=[];
      let seed=7103+formation*137;
      function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
      function sphere(r){const y=random()*2-1,a=random()*Math.PI*2,s=Math.sqrt(1-y*y);return new THREE.Vector3(s*Math.cos(a),y,s*Math.sin(a)).multiplyScalar(r);}
      const nodes=[],edges=[],seen=new Set(),palette=[0x8e9aff,0x56cde7,0xbb9cf5,0x719fe2,0x9e81de,0x66bdcb,0xc1b2f0,0x85a9ed];
      function node(p,c,hub=false){nodes.push({p,links:[],distance:Infinity,color:new THREE.Color(palette[c%palette.length]),size:hub?12:3.5+random()*3});return nodes.length-1;}
      function edge(a,b,strength){if(a===b)return;const key=Math.min(a,b)+':'+Math.max(a,b);if(seen.has(key))return;seen.add(key);edges.push({a,b,strength});const length=nodes[a].p.distanceTo(nodes[b].p);nodes[a].links.push({b,length});nodes[b].links.push({b:a,length});}
      const root=node(new THREE.Vector3(),0,true);
      if(formation===0){
        const hubs=[];
        for(let c=0;c<8;c++){
          const y=1-2*(c+.5)/8,a=c*2.399963,r=Math.sqrt(1-y*y),center=new THREE.Vector3(r*Math.cos(a),y,r*Math.sin(a)).multiplyScalar(.94);
          const hub=node(center,c,true);hubs.push(hub);edge(root,hub,.8);const members=[hub];
          for(let i=0;i<Math.floor(112*density);i++){const offset=sphere(Math.cbrt(random())*.53);offset.y*=.88;members.push(node(center.clone().add(offset),c));}
          for(const id of members.slice(1)){
            const nearest=members.filter(j=>j!==id).sort((a,b)=>nodes[id].p.distanceToSquared(nodes[a].p)-nodes[id].p.distanceToSquared(nodes[b].p));
            nearest.slice(0,4).forEach(j=>edge(id,j,.23+random()*.18));
            const inward=members.filter(j=>j!==id&&nodes[j].p.distanceTo(center)<nodes[id].p.distanceTo(center)).sort((a,b)=>nodes[a].p.distanceToSquared(nodes[id].p)-nodes[b].p.distanceToSquared(nodes[id].p));
            edge(id,inward[0]??hub,.38);
          }
        }
        // Fine bridges connect the clusters into a continuous neural volume.
        hubs.forEach((h,i)=>{for(const step of [1,3]){
          const other=hubs[(i+step)%hubs.length];let previous=h;
          for(let j=1;j<=7;j++){
            const p=nodes[h].p.clone().lerp(nodes[other].p,j/8).add(sphere(.075));
            const id=node(p,i);edge(previous,id,.48);previous=id;
          }
          edge(previous,other,.48);
        }});
        const interior=[];
        for(let i=0;i<Math.floor(180*density);i++)interior.push(node(sphere(Math.cbrt(random())*.83),i%8));
        for(const id of interior){
          const nearest=nodes.map((_,j)=>j).filter(j=>j!==id).sort((a,b)=>nodes[id].p.distanceToSquared(nodes[a].p)-nodes[id].p.distanceToSquared(nodes[b].p));
          nearest.slice(0,4).forEach(j=>edge(id,j,.23));
          edge(id,hubs[iClosestHub(id)],.34);
        }
        function iClosestHub(id){let closest=0;for(let i=1;i<hubs.length;i++)if(nodes[id].p.distanceToSquared(nodes[hubs[i]].p)<nodes[id].p.distanceToSquared(nodes[hubs[closest]].p))closest=i;return closest;}
      }else if(formation===1){
        const strands=[],count=Math.floor(180*density);
        for(let c=0;c<3;c++){const ids=[];for(let i=0;i<count;i++){const u=i/(count-1),a=u*Math.PI*5+c*Math.PI*2/3,r=.28+.6*Math.sin(u*Math.PI);
          ids.push(node(new THREE.Vector3(Math.cos(a)*r,(u-.5)*2.6,Math.sin(a)*r),c,i%18===0));if(i)edge(ids[i-1],ids[i],.65);}
          edge(root,ids[Math.floor(count/2)],.8);strands.push(ids);}
        strands.forEach((ids,c)=>ids.forEach((id,i)=>{if(i%3===0)edge(id,strands[(c+1)%3][i],.25);
          if(i+5<ids.length)edge(id,ids[i+5],.22);
          if(i%2===0){const satellite=node(nodes[id].p.clone().add(sphere(.13)),c);edge(id,satellite,.3);}}));
      }else{
        function branch(start,dir,depth,length,c){const end=node(nodes[start].p.clone().addScaledVector(dir,length),c,depth<2);edge(start,end,.85-depth*.14);
          if(depth>=4)return;for(let i=0;i<3;i++)branch(end,dir.clone().add(sphere(.8)).normalize(),depth+1,length*.64,c);}
        for(let c=0;c<9;c++)branch(root,sphere(1),0,.51,c);
      }
      // Shared shortest-path distance aligns signal timing at graph junctions.
      nodes[root].distance=0;const visited=new Set();
      for(let k=0;k<nodes.length;k++){let idx=-1,best=Infinity;nodes.forEach((n,i)=>{if(!visited.has(i)&&n.distance<best){idx=i;best=n.distance;}});if(idx<0)break;visited.add(idx);
        for(const {b,length} of nodes[idx].links)nodes[b].distance=Math.min(nodes[b].distance,best+length);}
      const pos=[],colors=[],sizes=[],distances=[];
      nodes.forEach(n=>{pos.push(...n.p.toArray());colors.push(...n.color.toArray());sizes.push(n.size);distances.push(Number.isFinite(n.distance)?n.distance:0);});
      const geometry=new THREE.BufferGeometry();
      for(const [key,data,size] of [['position',pos,3],['color',colors,3],['size',sizes,1],['travel',distances,1]])geometry.setAttribute(key,new THREE.Float32BufferAttribute(data,size));
      const points=new THREE.Points(geometry,new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
        vertexShader:common+`attribute vec3 color;attribute float size,travel;varying vec3 tint;varying float light;
          void main(){light=signal(travel)+impulse(position);tint=color;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;
            gl_PointSize=clamp(size*(1.+light*.5+activity*.2)*5./max(1.,-p.z),1.5,26.);}`,
        fragmentShader:common+`varying vec3 tint;varying float light;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;
          float halo=exp(-r*r*5.)*(1.-smoothstep(.7,1.,r)),center=exp(-r*r*36.);
          gl_FragColor=vec4(tint*(.7+light*.6)+vec3(center*.5),halo*(.62+light*.38)*visibility);}`}));
      const lp=[],lc=[],ld=[],ls=[];
      for(const e of edges){const a=nodes[e.a],b=nodes[e.b],mid=a.p.clone().lerp(b.p,.5).multiplyScalar(e.strength>.6?1.12:1.02),curve=new THREE.QuadraticBezierCurve3(a.p,mid,b.p),segments=e.strength>.6?16:3;
        for(let j=0;j<segments;j++)for(const u of [j/segments,(j+1)/segments]){lp.push(...curve.getPoint(u).toArray());lc.push(...a.color.clone().lerp(b.color,u).toArray());ld.push(THREE.MathUtils.lerp(a.distance,b.distance,u));ls.push(e.strength);}}
      const lg=new THREE.BufferGeometry();for(const [key,data,size] of [['position',lp,3],['color',lc,3],['travel',ld,1],['strength',ls,1]])lg.setAttribute(key,new THREE.Float32BufferAttribute(data,size));
      const lines=new THREE.LineSegments(lg,new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
        vertexShader:`attribute vec3 color;attribute float travel,strength;varying vec3 tint,localPos;varying float dist,weight;
          void main(){tint=color;localPos=position;dist=travel;weight=strength;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader:common+`varying vec3 tint,localPos;varying float dist,weight;void main(){float light=signal(dist)*(.5+activity*.6)+impulse(localPos);
          gl_FragColor=vec4(tint*(.85+light*.8),(.16+weight*.32+light*.48)*visibility);}`}));
      meshes=[points,lines];group.add(points,lines);
    }
    build();
    return {group,
      update(t,level,locked=false,voiceBreath=0,state='idle'){
        const dt=Math.min(.05,Math.max(0,t-(lastTime||t)));lastTime=t;
        clock+=dt*(state==='thinking'?1.8:state==='speaking'?1.15:state==='listening'?.7:.45);uniforms.time.value=clock;
        uniforms.activity.value+=(Math.min(1,(level||0)*.5+(state==='thinking'?.6:0))-uniforms.activity.value)*(1-Math.exp(-dt*5));
        const target=document.body.classList.contains('knowledge-reading')?.16:backdrop?.8:1;
        visibility+=(target-visibility)*(1-Math.exp(-dt*4));uniforms.visibility.value=visibility*(1+voiceBreath*.2);
        if(!locked){group.rotation.y=Math.sin(t*.08)*.14;group.scale.setScalar(1.16*(1+Math.sin(t*.75)*.012));}},
      pulse(){pulseIndex=(pulseIndex+1)%3;uniforms.pulseTimes.value[pulseIndex]=clock;},
      point(nx,ny,present){uniforms.hand.value.set(nx*1.5,-ny,.4);uniforms.handOn.value=present?1:0;},
      setBackdrop(value){backdrop=Boolean(value);},
      cycleFormation(){formation=(formation+1)%3;build();return formation;},
      setDensity(value){density=Math.max(.3,Math.min(2,Number(value)||1));build();}
    };
  };
})();
