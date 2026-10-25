export const chatAnswerSchema = {
  type:"object",additionalProperties:false,required:["sections"],
  properties:{sections:{type:"array",items:{type:"object",additionalProperties:false,
    required:["snapshotId","text","annotationIds"],properties:{
      snapshotId:{type:["string","null"]},text:{type:"string"},annotationIds:{type:"array",items:{type:"string"}},
    },
  }}},
};
