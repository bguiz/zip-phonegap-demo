'use strict';

function writeOutMessage(message) {
  var elem = document.getElementById('out');
  elem.appendChild(document.createTextNode(message));
  elem.appendChild(document.createElement('br'));
}

// Generic error handler
//TODO rpelace usages of this with specific error handler for each usage
function onFail(err) {
  console.log(err);
  throw err;
}
